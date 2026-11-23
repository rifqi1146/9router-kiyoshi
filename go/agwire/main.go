// Package main is the agwire sidecar: an outbound wire sender that speaks with
// Go's own crypto/tls stack instead of Node's.
//
// The JS wire sender (open-sse/utils/antigravityWire.js) can drive the exact
// HTTP/1.1 header set, but the TLS ClientHello it emits is Node's — a different
// cipher list, extension list and key-share set from the native client it is
// imitating. This process is the same language and the same TLS stack as that
// client, so the upstream sees a genuine Go handshake (HTTP/1.1 ALPN, the Go
// default cipher suites, X25519MLKEM768 + X25519 key shares).
//
// Protocol (loopback only, one JSON line on stdout at startup):
//
//	{"port":N}\n
//
//	POST /wire
//	X-Agwire-Token: <AGWIRE_TOKEN>
//	X-Agwire-Meta: <JSON>
//	body: raw upstream request body
//	response: upstream status, headers and streamed body
//
// It exits 0 as soon as stdin closes, so it can never outlive its parent. Set
// AGWIRE_ALLOW_TEST_HOSTS=1 to allow non-Cloud-Code hosts, insecure TLS and a
// pinned connectHost — test-only, ignored by the JS side in production.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	maxMetaBytes    = 64 << 10  // X-Agwire-Meta JSON
	maxHeadBytes    = 64 << 10  // upstream response head
	maxConnectHead  = 16 << 10  // proxy CONNECT reply
	maxIdlePerKey   = 8         // parked connections per origin::proxy
	idleTTL         = 60 * time.Second
	dnsTTL          = 5 * time.Minute
	maxBufferedBody = 8 << 20 // larger bodies stream once and cannot be retried
	dialTimeout     = 20 * time.Second
	// Response-head backstop only. The native client has none, and the JS caller
	// aborts at FETCH_CONNECT_TIMEOUT_MS (120s) and cancels this request's
	// context, so a short deadline here would 502 a slow first token.
	headTimeout  = 5 * time.Minute
	backendLabel = "go-crypto-tls"
)

// antigravityHosts mirrors ANTIGRAVITY_HOSTS in antigravityWire.js. Anything
// else is an SSRF attempt unless the test-only override is set.
var antigravityHosts = map[string]bool{
	"daily-cloudcode-pa.googleapis.com": true,
	"cloudcode-pa.googleapis.com":       true,
	"aicode.googleapis.com":             true,
}

var allowedMethods = map[string]bool{
	"GET": true, "POST": true, "HEAD": true, "PUT": true,
	"DELETE": true, "OPTIONS": true, "PATCH": true,
}

// Hop-by-hop headers are never forwarded: the upstream connection is ours, the
// client connection is Node's, and each hop negotiates its own framing.
var hopHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"proxy-connection":    true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

type wireMeta struct {
	URL         string     `json:"url"`
	Method      string     `json:"method"`
	Headers     [][]string `json:"headers"`
	ProxyURL    string     `json:"proxyUrl"`
	ALPN        []string   `json:"alpn"`
	AllowReuse  *bool      `json:"allowReuse"`
	InsecureTLS bool       `json:"insecureTls"`
	ConnectHost string     `json:"connectHost"`
}

func (m wireMeta) reuseEnabled() bool {
	return m.AllowReuse == nil || *m.AllowReuse
}

type sidecar struct {
	token string
	h1    *connPool
	h2    *transportPool
}

func newSidecar(token string) *sidecar {
	return &sidecar{token: token, h1: newConnPool(), h2: newTransportPool()}
}

func (s *sidecar) reset() {
	s.h1.closeAll()
	s.h2.closeAll()
}

func (s *sidecar) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/wire", s.handleWire)
	return mux
}

func allowTestHosts() bool { return os.Getenv("AGWIRE_ALLOW_TEST_HOSTS") == "1" }

// ─── request handling ──────────────────────────────────────────────────────

func (s *sidecar) handleWire(w http.ResponseWriter, r *http.Request) {
	if s.token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Agwire-Token")), []byte(s.token)) != 1 {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	meta, target, proxy, err := parseMeta(r.Header.Get("X-Agwire-Meta"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// allowTest is captured once: both insecureTls and connectHost are honored
	// only in test mode, so a production caller cannot redirect or downgrade.
	allowTest := allowTestHosts()
	if !allowTest {
		meta.InsecureTLS = false
		meta.ConnectHost = ""
	}
	if meta.ConnectHost != "" && net.ParseIP(meta.ConnectHost) == nil {
		writeError(w, http.StatusBadRequest, "invalid connectHost")
		return
	}

	payload, err := readPayload(r.Body, r.ContentLength)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx := r.Context()
	via := ""
	if proxy != nil {
		via = proxyLabel(proxy)
	}
	origin := target.Scheme + "://" + target.Host
	key := poolKey(origin, meta.ProxyURL)

	if wantsHTTP2(meta.ALPN) {
		if err := s.roundTripH2(ctx, w, meta, target, proxy, payload, via, allowTest); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
		}
		return
	}

	res, retryable, err := s.sendH1(ctx, key, meta, target, proxy, payload, true, allowTest)
	if err != nil && retryable && res != nil && res.reused && payload.bytes != nil && ctx.Err() == nil {
		// A parked socket can be closed by an idle upstream between park and
		// reuse. Retry once on a fresh connection — the buffered body is replayable
		// and no response byte was received, so the upstream cannot have answered.
		res, _, err = s.sendH1(ctx, key, meta, target, proxy, payload, false, allowTest)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	s.relay(w, meta.Method, res, via)
}

// relay copies an upstream response to the client, streaming and flushing.
func openDecompressor(method string, resp *http.Response) (io.ReadCloser, bool, error) {
	if method == http.MethodHead || resp.StatusCode == http.StatusNoContent || resp.StatusCode == 205 || resp.StatusCode == http.StatusNotModified || resp.ContentLength == 0 {
		return nil, false, nil
	}
	switch strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))) {
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, false, fmt.Errorf("bad gzip response: %w", err)
		}
		return zr, true, nil
	case "deflate":
		zr, err := zlib.NewReader(resp.Body)
		if err != nil {
			return nil, false, fmt.Errorf("bad deflate response: %w", err)
		}
		return zr, true, nil
	default:
		return nil, false, nil
	}
}

func (s *sidecar) relay(w http.ResponseWriter, method string, res *h1Result, via string) {
	body := io.Reader(res.resp.Body)
	zr, decompressed, err := openDecompressor(method, res.resp)
	if err != nil {
		s.abandon(res)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if zr != nil {
		defer zr.Close()
		body = zr
	}
	copyHeaders(w.Header(), res.resp.Header, decompressed)
	if via != "" {
		w.Header().Set("X-9r-Proxy-Via", via)
	}
	w.Header().Set("X-Agwire-Backend", backendLabel)
	w.WriteHeader(res.resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	buf := make([]byte, 32<<10)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				s.abandon(res)
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr == io.EOF {
			s.finish(res)
			return
		}
		if rerr != nil {
			s.abandon(res)
			// Headers are already out, so this is the only way left to tell Node
			// the body is truncated instead of a clean, shorter response.
			panic(http.ErrAbortHandler)
		}
	}
}

// finish drains the rest of the response (trailers) and parks a reusable socket.
func (s *sidecar) finish(res *h1Result) {
	_, _ = io.Copy(io.Discard, res.resp.Body)
	_ = res.resp.Body.Close()
	defer res.stopCancel()
	// Any byte left unread past the body means the connection is out of sync:
	// combined holds the post-body tail, br holds anything it never pulled.
	if res.allowPark && !res.resp.Close && res.br.Buffered() == 0 && res.combined.Buffered() == 0 {
		s.h1.park(res.key, res.conn)
		return
	}
	_ = res.conn.Close()
}

func (s *sidecar) abandon(res *h1Result) {
	res.stopCancel()
	_ = res.resp.Body.Close()
	_ = res.conn.Close()
}

// ─── metadata parsing / validation ─────────────────────────────────────────

func parseMeta(raw string) (wireMeta, *url.URL, *url.URL, error) {
	var meta wireMeta
	if raw == "" {
		return meta, nil, nil, errors.New("missing X-Agwire-Meta")
	}
	if len(raw) > maxMetaBytes {
		return meta, nil, nil, errors.New("X-Agwire-Meta too large")
	}
	if err := json.Unmarshal([]byte(raw), &meta); err != nil {
		return meta, nil, nil, errors.New("invalid X-Agwire-Meta")
	}
	if !allowedMethods[meta.Method] || !isToken(meta.Method) {
		return meta, nil, nil, errors.New("invalid method")
	}
	if hasCtl(meta.Method) || hasCtl(meta.URL) || hasCtl(meta.ProxyURL) || hasCtl(meta.ConnectHost) {
		return meta, nil, nil, errors.New("invalid control character")
	}

	target, err := url.Parse(meta.URL)
	if err != nil || target.Host == "" || target.Hostname() == "" {
		return meta, nil, nil, errors.New("invalid url")
	}
	// A fragment is never part of an HTTP request target. Accepting and dropping
	// it would let a caller believe the URL it sent is the URL that was used.
	if target.Fragment != "" || target.RawFragment != "" || strings.Contains(meta.URL, "#") {
		return meta, nil, nil, errors.New("url must not carry a fragment")
	}
	if target.Scheme != "https" {
		return meta, nil, nil, errors.New("url must be https")
	}
	if target.User != nil {
		return meta, nil, nil, errors.New("url must not carry credentials")
	}
	host := strings.ToLower(target.Hostname())
	if !allowTestHosts() && !antigravityHosts[host] {
		return meta, nil, nil, errors.New("host not allowed")
	}
	if _, err := targetPort(target); err != nil {
		return meta, nil, nil, err
	}
	if reqURI := target.RequestURI(); strings.ContainsAny(reqURI, " \t\r\n\x00") {
		return meta, nil, nil, errors.New("invalid url path")
	}
	for _, proto := range meta.ALPN {
		if proto == "" || hasCtl(proto) {
			return meta, nil, nil, errors.New("invalid alpn")
		}
	}

	for _, h := range meta.Headers {
		if len(h) != 2 {
			return meta, nil, nil, errors.New("invalid header pair")
		}
		name, value := h[0], h[1]
		if !isToken(name) {
			return meta, nil, nil, errors.New("invalid header name")
		}
		if hasCtl(value) {
			return meta, nil, nil, errors.New("invalid header value")
		}
	}
	var proxy *url.URL
	if meta.ProxyURL != "" {
		proxy, err = url.Parse(meta.ProxyURL)
		if err != nil || proxy.Host == "" || proxy.Hostname() == "" {
			return meta, nil, nil, errors.New("invalid proxyUrl")
		}
		if p := proxy.Port(); p != "" {
			n, perr := strconv.Atoi(p)
			if perr != nil || n <= 0 || n > 65535 {
				return meta, nil, nil, errors.New("invalid proxyUrl port")
			}
		}
		switch strings.ToLower(proxy.Scheme) {
		case "http", "https", "socks4", "socks4a", "socks5", "socks5h":
		default:
			return meta, nil, nil, errors.New("unsupported proxy scheme")
		}
		if proxy.User != nil {
			if _, err := proxyCredentials(proxy); err != nil {
				return meta, nil, nil, err
			}
		}
	}
	return meta, target, proxy, nil
}

func proxyCredentials(p *url.URL) (string, error) {
	user := p.User.Username()
	pass, _ := p.User.Password()
	if hasCtl(user) || hasCtl(pass) {
		return "", errors.New("invalid proxy credentials")
	}
	return user + ":" + pass, nil
}

// isToken reports whether s is an RFC 9110 token.
func isToken(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			continue
		}
		if strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0 {
			continue
		}
		return false
	}
	return true
}

// hasCtl rejects CR/LF/NUL and any other control byte: those are what turns a
// header value into a second request (request smuggling).
func hasCtl(s string) bool {
	for i := range len(s) {
		c := s[i]
		if c == '\t' {
			continue
		}
		if c < 0x20 || c == 0x7f {
			return true
		}
	}
	return false
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}

// ─── payload ───────────────────────────────────────────────────────────────

type payload struct {
	bytes    []byte    // replayable body
	live     io.Reader // single-use body (over maxBufferedBody)
	knownLen int64
}

func (p payload) reader() io.Reader {
	if p.bytes != nil {
		return bytes.NewReader(p.bytes)
	}
	return p.live
}

func readPayload(r io.Reader, contentLength int64) (payload, error) {
	buf, err := io.ReadAll(io.LimitReader(r, maxBufferedBody+1))
	if err != nil {
		return payload{}, errors.New("cannot read request body")
	}
	if len(buf) <= maxBufferedBody {
		return payload{bytes: buf, knownLen: int64(len(buf))}, nil
	}
	// Oversized: hand the already-read prefix back with the live stream so the
	// body is still forwarded without a second copy.
	return payload{live: io.MultiReader(bytes.NewReader(buf), r), knownLen: contentLength}, nil
}

// ─── HTTP/1.1 exact-wire sender ────────────────────────────────────────────

type h1Result struct {
	resp       *http.Response
	conn       *tls.Conn
	br         *bufio.Reader
	combined   *bufio.Reader
	stopCancel func() bool
	key        string
	reused     bool
	allowPark  bool
}

func isTimeoutErr(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// sendH1 returns retryable=false whenever the upstream may have observed the
// request: a non-idempotent POST must never be replayed after that point.
func (s *sidecar) sendH1(
	ctx context.Context,
	key string,
	meta wireMeta,
	target *url.URL,
	proxy *url.URL,
	p payload,
	reuseOK bool,
	allowTest bool,
) (*h1Result, bool, error) {
	var conn *tls.Conn
	reused := false
	if reuseOK && meta.reuseEnabled() {
		conn = s.h1.take(key)
		reused = conn != nil
	}
	if conn == nil {
		var err error
		conn, err = dialTLS(ctx, meta, target, proxy, allowTest)
		if err != nil {
			return nil, false, err
		}
	}

	// Close the upstream socket when Node aborts or its request goes away, so a
	// cancelled turn cannot pin a goroutine on a read that has no deadline.
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	res := &h1Result{key: key, conn: conn, reused: reused, allowPark: true, stopCancel: stopCancel}
	if err := writeRequest(ctx, conn, meta, target, p); err != nil {
		stopCancel()
		_ = conn.Close()
		return res, ctx.Err() == nil, err
	}
	br := bufio.NewReaderSize(conn, 16<<10)
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(headTimeout)
	}
	_ = conn.SetReadDeadline(deadline)
	resp, combined, receivedAny, err := readResponse(br, meta.Method)
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil {
		stopCancel()
		_ = conn.Close()
		return res, !receivedAny && !isTimeoutErr(err) && ctx.Err() == nil, err
	}
	res.br = br
	res.combined = combined
	res.resp = resp
	return res, false, nil
}

// writeRequest emits `METHOD PATH HTTP/1.1` plus the caller's headers verbatim.
// Order and casing are preserved: the fingerprint is in those bytes.
func writeRequest(ctx context.Context, conn *tls.Conn, meta wireMeta, target *url.URL, p payload) error {
	body := p.reader()

	var head bytes.Buffer
	path := target.RequestURI()
	if path == "" {
		path = "/"
	}
	head.WriteString(meta.Method)
	head.WriteByte(' ')
	head.WriteString(path)
	head.WriteString(" HTTP/1.1\r\n")
	length := p.knownLen
	wroteLength := false
	for _, h := range meta.Headers {
		name, value := h[0], h[1]
		if strings.EqualFold(name, "transfer-encoding") {
			continue // framing is ours: a caller-supplied one desyncs the socket
		}
		if strings.EqualFold(name, "content-length") {
			if length < 0 {
				continue // unknown length: chunked framing is emitted below
			}
			// Never trust a caller-supplied length: a mismatch is a smuggling vector.
			value = strconv.FormatInt(length, 10)
			wroteLength = true
		}
		head.WriteString(name)
		head.WriteString(": ")
		head.WriteString(value)
		head.WriteString("\r\n")
	}
	if length < 0 {
		head.WriteString("Transfer-Encoding: chunked\r\n")
	} else if length > 0 && !wroteLength {
		// A body with no framing header would be read as a second request.
		head.WriteString("Content-Length: ")
		head.WriteString(strconv.FormatInt(length, 10))
		head.WriteString("\r\n")
	}
	head.WriteString("\r\n")

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(dialTimeout)
	}
	_ = conn.SetDeadline(deadline)
	defer conn.SetDeadline(time.Time{})

	if _, err := conn.Write(head.Bytes()); err != nil {
		return fmt.Errorf("write request head: %w", err)
	}
	if length < 0 {
		cw := httputil.NewChunkedWriter(conn)
		if _, err := io.Copy(cw, body); err != nil {
			return fmt.Errorf("write request body: %w", err)
		}
		if err := cw.Close(); err != nil {
			return fmt.Errorf("write request body: %w", err)
		}
		_, err := conn.Write([]byte("\r\n"))
		return err
	}
	if _, err := io.Copy(conn, body); err != nil {
		return fmt.Errorf("write request body: %w", err)
	}
	return nil
}

// readResponse bounds the response head, then hands the whole thing (head +
// buffered tail) to net/http so chunked decoding and trailers stay stdlib.
// receivedAny reports whether the upstream sent any byte at all, which is what
// separates a stale parked socket from an answered request.
func readResponse(br *bufio.Reader, method string) (*http.Response, *bufio.Reader, bool, error) {
	head, err := readHead(br, maxHeadBytes)
	if err != nil {
		return nil, nil, errors.Is(err, errPartialHead), err
	}
	combined := bufio.NewReader(io.MultiReader(bytes.NewReader(head), br))
	resp, err := http.ReadResponse(combined, &http.Request{Method: method})
	if err != nil {
		return nil, nil, true, fmt.Errorf("read response: %w", err)
	}
	return resp, combined, true, nil
}

var errPartialHead = errors.New("partial response head")

func readHead(br *bufio.Reader, limit int) ([]byte, error) {
	var head []byte
	for {
		line, err := br.ReadSlice('\n')
		head = append(head, line...)
		if len(head) > limit {
			return nil, fmt.Errorf("response head too large: %w", errPartialHead)
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			if len(head) > 0 {
				// Partial head: the upstream answered, so this is not a stale socket.
				return nil, fmt.Errorf("read response head: %w", errPartialHead)
			}
			return nil, fmt.Errorf("read response head: %w", err)
		}
		if bytes.HasSuffix(head, []byte("\r\n\r\n")) {
			return head, nil
		}
	}
}

// ─── TLS dial ──────────────────────────────────────────────────────────────

func dialTLS(ctx context.Context, meta wireMeta, target *url.URL, proxy *url.URL, allowTest bool) (*tls.Conn, error) {
	host := target.Hostname()
	port, err := targetPort(target)
	if err != nil {
		return nil, err
	}
	raw, err := dialTarget(ctx, proxy, host, port, meta.ConnectHost, allowTest, meta.InsecureTLS)
	if err != nil {
		return nil, err
	}
	alpn := meta.ALPN
	if len(alpn) == 0 {
		alpn = []string{"http/1.1"}
	}
	conn := tls.Client(raw, &tls.Config{
		ServerName: host,
		NextProtos: alpn,
		// Test-only, and the JS side never sets it: production verifies upstream certs.
		InsecureSkipVerify: allowTest && meta.InsecureTLS,
	})
	hsCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	if err := conn.HandshakeContext(hsCtx); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("tls handshake: %w", err)
	}
	return conn, nil
}

func targetPort(u *url.URL) (int, error) {
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 || n > 65535 {
			return 0, errors.New("invalid port")
		}
		return n, nil
	}
	if u.Scheme != "https" {
		return 0, errors.New("invalid scheme port")
	}
	return 443, nil
}

// dialTarget opens the TCP connection the TLS handshake runs over. It never
// falls back to a direct dial when a proxy is configured: that silent fallback
// is exactly the leak the wire layer exists to prevent.
func dialTarget(ctx context.Context, proxy *url.URL, host string, port int, connectHost string, allowTest bool, insecureTLS bool) (net.Conn, error) {
	if proxy != nil {
		return dialThroughProxy(ctx, proxy, host, port, connectHost, allowTest, insecureTLS)
	}
	dest := host
	if allowTest && connectHost != "" {
		dest = connectHost
	} else {
		dest = resolveIPv4(ctx, host)
	}
	d := &net.Dialer{Timeout: dialTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(dest, strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", dest, err)
	}
	return conn, nil
}

// ─── proxy tunneling (http/https CONNECT, SOCKS4/4a/5/5h) ──────────────────

func proxyLabel(p *url.URL) string {
	if p == nil {
		return ""
	}
	host := p.Hostname()
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if p.Port() != "" {
		return p.Scheme + "://" + host + ":" + p.Port()
	}
	return p.Scheme + "://" + host
}

func proxyDefaultPort(scheme string) string {
	switch scheme {
	case "https":
		return "443"
	case "socks4", "socks4a", "socks5", "socks5h":
		return "1080"
	default:
		return "80"
	}
}

func dialThroughProxy(ctx context.Context, proxy *url.URL, host string, port int, connectHost string, allowTest bool, insecureTLS bool) (net.Conn, error) {
	scheme := strings.ToLower(proxy.Scheme)
	switch scheme {
	case "http", "https":
		return dialHTTPTunnel(ctx, proxy, host, port, allowTest && insecureTLS)
	case "socks4", "socks4a":
		return dialSOCKS4(ctx, proxy, host, port, scheme == "socks4a", connectHost, allowTest)
	case "socks5", "socks5h":
		return dialSOCKS5(ctx, proxy, host, port, scheme == "socks5h", connectHost, allowTest)
	}
	return nil, errors.New("unsupported proxy scheme")
}

func dialProxy(ctx context.Context, proxy *url.URL, insecureTLS bool) (net.Conn, error) {
	proxyPort := proxy.Port()
	if proxyPort == "" {
		proxyPort = proxyDefaultPort(strings.ToLower(proxy.Scheme))
	}
	d := &net.Dialer{Timeout: dialTimeout}
	raw, err := d.DialContext(ctx, "tcp", net.JoinHostPort(proxy.Hostname(), proxyPort))
	if err != nil {
		return nil, fmt.Errorf("proxy %s unreachable: %w", proxyLabel(proxy), err)
	}
	if strings.EqualFold(proxy.Scheme, "https") {
		tlsConn := tls.Client(raw, &tls.Config{
			ServerName:         proxy.Hostname(),
			NextProtos:         []string{"http/1.1"},
			InsecureSkipVerify: insecureTLS,
		})
		hsCtx, cancel := context.WithTimeout(ctx, dialTimeout)
		defer cancel()
		if err := tlsConn.HandshakeContext(hsCtx); err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("proxy %s tls: %w", proxyLabel(proxy), err)
		}
		return tlsConn, nil
	}
	return raw, nil
}

func dialHTTPTunnel(ctx context.Context, proxy *url.URL, host string, port int, insecureTLS bool) (net.Conn, error) {
	raw, err := dialProxy(ctx, proxy, insecureTLS)
	if err != nil {
		return nil, err
	}
	authority := net.JoinHostPort(host, strconv.Itoa(port))
	var head strings.Builder
	head.WriteString("CONNECT " + authority + " HTTP/1.1\r\n")
	head.WriteString("Host: " + authority + "\r\n")
	if proxy.User != nil {
		creds, err := proxyCredentials(proxy)
		if err != nil {
			_ = raw.Close()
			return nil, err
		}
		head.WriteString("Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(creds)) + "\r\n")
	}
	head.WriteString("\r\n")

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(dialTimeout)
	}
	_ = raw.SetDeadline(deadline)
	if _, err := io.WriteString(raw, head.String()); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("proxy %s CONNECT write: %w", proxyLabel(proxy), err)
	}
	br := bufio.NewReaderSize(raw, 4096)
	reply, err := readHead(br, maxConnectHead)
	if err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("proxy %s CONNECT: %w", proxyLabel(proxy), err)
	}
	status := 0
	if line, _, _ := strings.Cut(string(reply), "\r\n"); line != "" {
		if fields := strings.Fields(line); len(fields) >= 2 && strings.HasPrefix(fields[0], "HTTP/1.") {
			if n, err := strconv.Atoi(fields[1]); err == nil {
				status = n
			}
		}
	}
	if status != http.StatusOK {
		_ = raw.Close()
		return nil, fmt.Errorf("proxy %s CONNECT failed: HTTP %d", proxyLabel(proxy), status)
	}
	_ = raw.SetDeadline(time.Time{})
	return &bufConn{Conn: raw, br: br}, nil
}

// bufConn replays bytes a bufio.Reader already pulled off the socket. Proxy
// handshakes leave the first TLS record in that buffer.
type bufConn struct {
	net.Conn
	br *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.br.Read(p) }

func dialSOCKS4(ctx context.Context, proxy *url.URL, host string, port int, remoteDNS bool, connectHost string, allowTest bool) (net.Conn, error) {
	raw, err := dialProxy(ctx, proxy, false)
	if err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(dialTimeout)
	}
	_ = raw.SetDeadline(deadline)

	req := []byte{0x04, 0x01, byte(port >> 8), byte(port)}
	if remoteDNS {
		req = append(req, 0, 0, 0, 1)
	} else {
		dest := host
		if allowTest && connectHost != "" {
			dest = connectHost
		} else {
			dest = resolveIPv4(ctx, host)
		}
		ip := net.ParseIP(dest).To4()
		if ip == nil {
			_ = raw.Close()
			return nil, fmt.Errorf("proxy %s: cannot resolve SOCKS4 target", proxyLabel(proxy))
		}
		req = append(req, ip...)
	}
	if proxy.User != nil {
		req = append(req, []byte(proxy.User.Username())...)
	}
	req = append(req, 0)
	if remoteDNS {
		req = append(req, []byte(host)...)
		req = append(req, 0)
	}
	if _, err := raw.Write(req); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("proxy %s SOCKS4 write: %w", proxyLabel(proxy), err)
	}
	var reply [8]byte
	if _, err := io.ReadFull(raw, reply[:]); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("proxy %s SOCKS4 reply: %w", proxyLabel(proxy), err)
	}
	if reply[1] != 0x5a {
		_ = raw.Close()
		return nil, fmt.Errorf("proxy %s SOCKS4 rejected: code %d", proxyLabel(proxy), reply[1])
	}
	_ = raw.SetDeadline(time.Time{})
	return raw, nil
}

func dialSOCKS5(ctx context.Context, proxy *url.URL, host string, port int, remoteDNS bool, connectHost string, allowTest bool) (net.Conn, error) {
	raw, err := dialProxy(ctx, proxy, false)
	if err != nil {
		return nil, err
	}
	br := bufio.NewReader(raw)
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(dialTimeout)
	}
	_ = raw.SetDeadline(deadline)
	fail := func(format string, args ...any) (net.Conn, error) {
		_ = raw.Close()
		return nil, fmt.Errorf("proxy %s: %w", proxyLabel(proxy), fmt.Errorf(format, args...))
	}

	wantsAuth := proxy.User != nil
	greeting := []byte{0x05, 0x01, 0x00}
	if wantsAuth {
		greeting = []byte{0x05, 0x02, 0x00, 0x02}
	}
	if _, err := raw.Write(greeting); err != nil {
		return fail("SOCKS5 greeting: %w", err)
	}
	var choice [2]byte
	if _, err := io.ReadFull(br, choice[:]); err != nil {
		return fail("SOCKS5 greeting reply: %w", err)
	}
	if choice[0] != 0x05 {
		return fail("SOCKS5 bad version %d", choice[0])
	}
	switch choice[1] {
	case 0x00:
	case 0x02:
		if proxy.User == nil {
			return fail("SOCKS5 auth required")
		}
		if _, err := proxyCredentials(proxy); err != nil {
			return fail("%w", err)
		}
		user := proxy.User.Username()
		pass, _ := proxy.User.Password()
		if len(user) > 255 || len(pass) > 255 {
			return fail("SOCKS5 credentials too long")
		}
		auth := []byte{0x01, byte(len(user))}
		auth = append(auth, user...)
		auth = append(auth, byte(len(pass)))
		auth = append(auth, pass...)
		if _, err := raw.Write(auth); err != nil {
			return fail("SOCKS5 auth write: %w", err)
		}
		var status [2]byte
		if _, err := io.ReadFull(br, status[:]); err != nil {
			return fail("SOCKS5 auth reply: %w", err)
		}
		if status[1] != 0x00 {
			return fail("SOCKS5 auth rejected")
		}
	case 0xff:
		return fail("SOCKS5 no acceptable auth method")
	default:
		return fail("SOCKS5 unsupported auth method %d", choice[1])
	}

	req := []byte{0x05, 0x01, 0x00}
	if remoteDNS {
		if len(host) > 255 {
			return fail("SOCKS5 host too long")
		}
		req = append(req, 0x03, byte(len(host)))
		req = append(req, host...)
	} else {
		dest := host
		if allowTest && connectHost != "" {
			dest = connectHost
		} else {
			dest = resolveIPv4(ctx, host)
		}
		ip := net.ParseIP(dest).To4()
		if ip == nil {
			return fail("cannot resolve SOCKS5 target")
		}
		req = append(req, 0x01)
		req = append(req, ip...)
	}
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := raw.Write(req); err != nil {
		return fail("SOCKS5 connect write: %w", err)
	}

	var head [4]byte
	if _, err := io.ReadFull(br, head[:]); err != nil {
		return fail("SOCKS5 connect reply: %w", err)
	}
	if head[0] != 0x05 {
		return fail("SOCKS5 bad version %d", head[0])
	}
	if head[1] != 0x00 {
		return fail("SOCKS5 connect rejected: code %d", head[1])
	}
	var skip int
	switch head[3] {
	case 0x01:
		skip = 4 + 2
	case 0x03:
		lenByte, err := br.ReadByte()
		if err != nil {
			return fail("SOCKS5 reply address: %w", err)
		}
		skip = int(lenByte) + 2
	case 0x04:
		skip = 16 + 2
	default:
		return fail("SOCKS5 unknown address type %d", head[3])
	}
	if _, err := io.CopyN(io.Discard, br, int64(skip)); err != nil {
		return fail("SOCKS5 reply tail: %w", err)
	}
	_ = raw.SetDeadline(time.Time{})
	return &bufConn{Conn: raw, br: br}, nil
}

// ─── DNS (Google DNS bypasses a /etc/hosts MITM redirect) ──────────────────

type dnsEntry struct {
	ip     string
	expiry time.Time
}

var dnsCache = struct {
	sync.Mutex
	m map[string]dnsEntry
}{m: map[string]dnsEntry{}}

func isLoopbackIP(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && (parsed.IsLoopback() || parsed.IsUnspecified())
}

func resolveIPv4(ctx context.Context, host string) string {
	if ip := net.ParseIP(host); ip != nil {
		return host
	}
	key := strings.ToLower(host)
	dnsCache.Lock()
	entry, ok := dnsCache.m[key]
	dnsCache.Unlock()
	if ok && time.Now().Before(entry.expiry) {
		return entry.ip
	}

	if addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host); err == nil {
		for _, addr := range addrs {
			if v4 := addr.IP.To4(); v4 != nil && !isLoopbackIP(v4.String()) {
				remember(key, v4.String())
				return v4.String()
			}
		}
	}
	for _, server := range []string{"8.8.8.8:53", "8.8.4.4:53"} {
		resolver := &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
				d := &net.Dialer{Timeout: 5 * time.Second}
				return d.DialContext(ctx, "udp", server)
			},
		}
		addrs, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			// A poisoned /etc/hosts answer must never redirect the direct dial.
			if v4 := addr.IP.To4(); v4 != nil && !isLoopbackIP(v4.String()) {
				remember(key, v4.String())
				return v4.String()
			}
		}
	}
	return host
}

func remember(host, ip string) {
	key := strings.ToLower(host)
	dnsCache.Lock()
	if len(dnsCache.m) >= 256 {
		clear(dnsCache.m)
	}
	dnsCache.m[key] = dnsEntry{ip: ip, expiry: time.Now().Add(dnsTTL)}
	dnsCache.Unlock()
}

// ─── HTTP/2 route ──────────────────────────────────────────────────────────

func wantsHTTP2(alpn []string) bool {
	for _, proto := range alpn {
		if proto == "h2" {
			return true
		}
	}
	return false
}

// roundTripH2 relays through net/http so the transport negotiates h2 itself and
// falls back to HTTP/1.1 when the upstream refuses it. Header order is not
// preserved here — h2 has no wire order to preserve.
func (s *sidecar) roundTripH2(
	ctx context.Context,
	w http.ResponseWriter,
	meta wireMeta,
	target *url.URL,
	proxy *url.URL,
	p payload,
	via string,
	allowTest bool,
) error {
	alpn := meta.ALPN
	if len(alpn) == 0 {
		alpn = []string{"h2", "http/1.1"}
	}
	trKey := fmt.Sprintf("%s::%s::%t::%s::%t", poolKey(target.Scheme+"://"+target.Host, meta.ProxyURL), strings.Join(alpn, ","), allowTest && meta.InsecureTLS, meta.ConnectHost, meta.reuseEnabled())
	tr := s.h2.get(trKey, meta, target, proxy, alpn, allowTest)

	var reqBody io.Reader = http.NoBody
	if p.knownLen != 0 {
		reqBody = io.NopCloser(p.reader())
	}
	req, err := http.NewRequestWithContext(ctx, meta.Method, target.String(), reqBody)
	if err != nil {
		return errors.New("cannot build request")
	}
	if p.knownLen >= 0 {
		req.ContentLength = p.knownLen
	}
	if len(p.bytes) > 0 {
		bodyBytes := p.bytes
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(bodyBytes)), nil
		}
	}
	// Header names listed by `Connection` are hop-by-hop too; net/http will not
	// strip them for us.
	drop := map[string]bool{}
	for _, h := range meta.Headers {
		if strings.EqualFold(h[0], "connection") {
			for _, token := range strings.Split(h[1], ",") {
				if token = strings.ToLower(strings.TrimSpace(token)); token != "" {
					drop[token] = true
				}
			}
		}
	}
	hasUA := false
	for _, h := range meta.Headers {
		name, value := h[0], h[1]
		lower := strings.ToLower(name)
		if hopHeaders[lower] || drop[lower] || lower == "host" || lower == "content-length" {
			continue
		}
		if lower == "user-agent" {
			hasUA = true
		}
		req.Header.Add(name, value)
	}
	if !hasUA {
		// An empty value suppresses Go's default "Go-http-client/2.0".
		req.Header.Set("User-Agent", "")
	}
	for _, h := range meta.Headers {
		if strings.EqualFold(h[0], "host") {
			req.Host = h[1]
			break
		}
	}

	resp, err := tr.RoundTrip(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body := io.Reader(resp.Body)
	zr, decompressed, err := openDecompressor(meta.Method, resp)
	if err != nil {
		return err
	}
	if zr != nil {
		defer zr.Close()
		body = zr
	}
	copyHeaders(w.Header(), resp.Header, decompressed)
	if via != "" {
		w.Header().Set("X-9r-Proxy-Via", via)
	}
	w.Header().Set("X-Agwire-Backend", backendLabel)
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	buf := make([]byte, 32<<10)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			// Headers are already out; abort so Node sees a truncated stream.
			panic(http.ErrAbortHandler)
		}
	}
}

func copyHeaders(dst, src http.Header, skipEncoding bool) {
	for name, values := range src {
		lower := strings.ToLower(name)
		// Sidecar markers are ours alone: an upstream must never claim it was
		// relayed by the Go backend or reached through a proxy label.
		if hopHeaders[lower] || lower == "x-agwire-backend" || lower == "x-9r-proxy-via" {
			continue
		}
		if skipEncoding && (lower == "content-encoding" || lower == "content-length") {
			continue
		}
		for _, value := range values {
			dst.Add(name, value)
		}
	}
}

// ─── connection pool (HTTP/1.1 keep-alive) ─────────────────────────────────

func poolKey(origin, proxyURL string) string {
	sum := sha256.Sum256([]byte(proxyURL))
	return origin + "::" + hex.EncodeToString(sum[:8])
}

type idleConn struct {
	conn    *tls.Conn
	expires time.Time
	timer   *time.Timer
}

type connPool struct {
	mu   sync.Mutex
	idle map[string][]idleConn
}

func newConnPool() *connPool { return &connPool{idle: map[string][]idleConn{}} }

func (p *connPool) take(key string) *tls.Conn {
	p.mu.Lock()
	defer p.mu.Unlock()
	pool := p.idle[key]
	for len(pool) > 0 {
		entry := pool[len(pool)-1]
		pool = pool[:len(pool)-1]
		if entry.timer != nil {
			entry.timer.Stop()
		}
		if time.Now().After(entry.expires) {
			_ = entry.conn.Close()
			continue
		}
		if len(pool) == 0 {
			delete(p.idle, key)
		} else {
			p.idle[key] = pool
		}
		return entry.conn
	}
	delete(p.idle, key)
	return nil
}

func (p *connPool) park(key string, conn *tls.Conn) {
	if conn == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	pool := p.idle[key]
	for len(pool) >= maxIdlePerKey {
		if pool[0].timer != nil {
			pool[0].timer.Stop()
		}
		_ = pool[0].conn.Close()
		pool = pool[1:]
	}
	timer := time.AfterFunc(idleTTL, func() { p.expire(key, conn) })
	pool = append(pool, idleConn{conn: conn, expires: time.Now().Add(idleTTL), timer: timer})
	p.idle[key] = pool
}

func (p *connPool) expire(key string, conn *tls.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pool := p.idle[key]
	for i, entry := range pool {
		if entry.conn == conn {
			_ = entry.conn.Close()
			pool = append(pool[:i], pool[i+1:]...)
			if len(pool) == 0 {
				delete(p.idle, key)
			} else {
				p.idle[key] = pool
			}
			return
		}
	}
}

func (p *connPool) closeAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for key, pool := range p.idle {
		for _, entry := range pool {
			if entry.timer != nil {
				entry.timer.Stop()
			}
			_ = entry.conn.Close()
		}
		delete(p.idle, key)
	}
}

// ─── transport pool (HTTP/2) ───────────────────────────────────────────────

// Bounded: the transport key includes caller-controlled fields, so an unbounded
// map would let each new connectHost/insecure flag pin a transport forever.
const maxTransports = 64

type transportPool struct {
	mu    sync.Mutex
	byKey map[string]*http.Transport
	order []string
}

func newTransportPool() *transportPool {
	return &transportPool{byKey: map[string]*http.Transport{}}
}

func (p *transportPool) get(
	key string,
	meta wireMeta,
	target *url.URL,
	proxy *url.URL,
	alpn []string,
	allowTest bool,
) *http.Transport {
	p.mu.Lock()
	defer p.mu.Unlock()
	if tr, ok := p.byKey[key]; ok {
		return tr
	}
	for len(p.order) >= maxTransports {
		oldest := p.order[0]
		p.order = p.order[1:]
		if old, ok := p.byKey[oldest]; ok {
			old.CloseIdleConnections()
			delete(p.byKey, oldest)
		}
	}
	host := target.Hostname()
	port, err := targetPort(target)
	if err != nil {
		port = 443
	}
	tr := &http.Transport{
		ForceAttemptHTTP2:   true,
		DisableKeepAlives:   !meta.reuseEnabled(),
		MaxIdleConnsPerHost: maxIdlePerKey,
		IdleConnTimeout:     idleTTL,
		DisableCompression:  true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			// The proxy dialer does its own DNS; direct dials resolve explicitly.
			return dialTarget(ctx, proxy, host, port, meta.ConnectHost, allowTest, meta.InsecureTLS)
		},
		TLSClientConfig: &tls.Config{
			ServerName:         host,
			NextProtos:         alpn,
			InsecureSkipVerify: allowTest && meta.InsecureTLS,
		},
	}
	p.byKey[key] = tr
	p.order = append(p.order, key)
	return tr
}

func (p *transportPool) closeAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for key, tr := range p.byKey {
		tr.CloseIdleConnections()
		delete(p.byKey, key)
	}
	p.order = nil
}

// ─── lifecycle ─────────────────────────────────────────────────────────────

func main() {
	token := os.Getenv("AGWIRE_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "agwire: AGWIRE_TOKEN is required")
		os.Exit(1)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "agwire: listen: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "{\"port\":%d}\n", listener.Addr().(*net.TCPAddr).Port)
	_ = os.Stdout.Sync()

	sc := newSidecar(token)
	srv := &http.Server{
		Handler:           sc.handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	shutdown := make(chan struct{})
	var shutdownOnce sync.Once
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	stop := func() {
		shutdownOnce.Do(func() {
			signal.Stop(signals)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
			sc.reset()
			close(shutdown)
		})
	}
	go func() {
		// Parent exit closes our stdin: never leave an orphan bound to a port.
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
	go func() {
		<-signals
		stop()
	}()

	if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintf(os.Stderr, "agwire: serve: %v\n", err)
		os.Exit(1)
	}
	<-shutdown
	os.Exit(0)
}
