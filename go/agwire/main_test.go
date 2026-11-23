package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func newTestCert(t *testing.T, hosts ...string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: hosts[0]},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     hosts,
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func startTestSidecar(t *testing.T) (*httptest.Server, *sidecar) {
	t.Helper()
	sc := newSidecar(testToken)
	srv := httptest.NewServer(sc.handler())
	t.Cleanup(func() {
		sc.reset()
		srv.Close()
	})
	return srv, sc
}

func postWire(t *testing.T, sidecarURL, token string, meta map[string]any, body string) *http.Response {
	t.Helper()
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, sidecarURL+"/wire", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("X-Agwire-Token", token)
	}
	req.Header.Set("X-Agwire-Meta", string(metaBytes))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// parseClientHello extracts cipher suites, extension types, ALPNs and key-share
// groups from a raw TLS ClientHello record.
type parsedHello struct {
	ciphers    []uint16
	extensions []uint16
	keyShares  []uint16
	alpn       []string
}

func parseClientHelloRecord(rec []byte) (parsedHello, error) {
	var out parsedHello
	if len(rec) < 9 || rec[0] != 0x16 || rec[5] != 0x01 {
		return out, fmt.Errorf("not a TLS ClientHello record")
	}
	recLen := int(binary.BigEndian.Uint16(rec[3:5]))
	if len(rec) < 5+recLen {
		return out, fmt.Errorf("truncated TLS record")
	}
	p := rec[9 : 5+recLen] // skip record header (5) + handshake header (4)
	if len(p) < 34 {
		return out, fmt.Errorf("short ClientHello")
	}
	p = p[34:] // legacy_version (2) + random (32)
	if len(p) < 1 {
		return out, fmt.Errorf("missing session_id")
	}
	sidLen := int(p[0])
	p = p[1+sidLen:]
	if len(p) < 2 {
		return out, fmt.Errorf("missing cipher_suites")
	}
	csLen := int(binary.BigEndian.Uint16(p[:2]))
	p = p[2:]
	for i := 0; i+1 < csLen; i += 2 {
		out.ciphers = append(out.ciphers, binary.BigEndian.Uint16(p[i:i+2]))
	}
	p = p[csLen:]
	if len(p) < 1 {
		return out, fmt.Errorf("missing compression_methods")
	}
	compLen := int(p[0])
	p = p[1+compLen:]
	if len(p) < 2 {
		return out, fmt.Errorf("missing extensions")
	}
	extTotal := int(binary.BigEndian.Uint16(p[:2]))
	p = p[2 : 2+extTotal]
	for len(p) >= 4 {
		extType := binary.BigEndian.Uint16(p[:2])
		extLen := int(binary.BigEndian.Uint16(p[2:4]))
		extData := p[4 : 4+extLen]
		out.extensions = append(out.extensions, extType)
		switch extType {
		case 16: // ALPN
			if len(extData) >= 2 {
				listLen := int(binary.BigEndian.Uint16(extData[:2]))
				q := extData[2 : 2+listLen]
				for len(q) > 0 {
					l := int(q[0])
					out.alpn = append(out.alpn, string(q[1:1+l]))
					q = q[1+l:]
				}
			}
		case 51: // key_share
			if len(extData) >= 2 {
				listLen := int(binary.BigEndian.Uint16(extData[:2]))
				q := extData[2 : 2+listLen]
				for len(q) >= 4 {
					group := binary.BigEndian.Uint16(q[:2])
					klen := int(binary.BigEndian.Uint16(q[2:4]))
					out.keyShares = append(out.keyShares, group)
					q = q[4+klen:]
				}
			}
		}
		p = p[4+extLen:]
	}
	return out, nil
}

type captureConn struct {
	net.Conn
	buf bytes.Buffer
	mu  sync.Mutex
	cap bool
}

func (c *captureConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.mu.Lock()
	if c.cap && n > 0 {
		c.buf.Write(p[:n])
		if c.buf.Len() >= 5 {
			recLen := int(binary.BigEndian.Uint16(c.buf.Bytes()[3:5]))
			if c.buf.Len() >= 5+recLen {
				c.cap = false
			}
		}
	}
	c.mu.Unlock()
	return n, err
}

func TestClientHelloFingerprint(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	cert := newTestCert(t, "daily-cloudcode-pa.googleapis.com")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	helloCh := make(chan parsedHello, 1)
	go func() {
		raw, err := ln.Accept()
		if err != nil {
			return
		}
		cc := &captureConn{Conn: raw, cap: true}
		tc := tls.Server(cc, &tls.Config{
			Certificates: []tls.Certificate{cert},
			NextProtos:   []string{"http/1.1"},
		})
		defer tc.Close()
		if err := tc.Handshake(); err != nil {
			return
		}
		hello, err := parseClientHelloRecord(cc.buf.Bytes())
		if err == nil {
			helloCh <- hello
		}
		br := bufio.NewReader(tc)
		_, _ = http.ReadRequest(br)
		_, _ = io.WriteString(tc, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	}()

	srv, _ := startTestSidecar(t)
	port := ln.Addr().(*net.TCPAddr).Port
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "{}")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	hello := <-helloCh
	if len(hello.ciphers) != 13 {
		t.Fatalf("cipher count = %d, want 13 (%v)", len(hello.ciphers), hello.ciphers)
	}
	if len(hello.extensions) != 12 {
		t.Fatalf("extension count = %d, want 12 (%v)", len(hello.extensions), hello.extensions)
	}
	if len(hello.alpn) != 1 || hello.alpn[0] != "http/1.1" {
		t.Fatalf("alpn = %v, want [http/1.1]", hello.alpn)
	}
	// Go 1.25 sends X25519MLKEM768 (0x11ec) + X25519 (0x001d) key shares.
	if len(hello.keyShares) != 2 || hello.keyShares[0] != uint16(tls.X25519MLKEM768) || hello.keyShares[1] != uint16(tls.X25519) {
		t.Fatalf("keyShares = %#x, want [0x11ec 0x001d]", hello.keyShares)
	}
}

func TestExactHeaderOrderAndCasing(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	cert := newTestCert(t, "daily-cloudcode-pa.googleapis.com")

	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	rawHeadCh := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		var head strings.Builder
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			head.WriteString(line)
			if line == "\r\n" {
				break
			}
		}
		rawHeadCh <- head.String()
		_, _ = io.CopyN(io.Discard, br, 2)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	}()

	srv, _ := startTestSidecar(t)
	port := ln.Addr().(*net.TCPAddr).Port
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":    fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", port),
		"method": "POST",
		"headers": [][]string{
			{"Host", "daily-cloudcode-pa.googleapis.com"},
			{"User-Agent", "antigravity/1.5.15 linux/amd64"},
			{"Content-Length", "999"}, // must be overwritten with actual body length
			{"Authorization", "Bearer tok"},
			{"Content-Type", "application/json"},
			{"Accept-Encoding", "gzip"},
		},
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "{}")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	want := strings.Join([]string{
		"POST /v1internal:loadCodeAssist HTTP/1.1",
		"Host: daily-cloudcode-pa.googleapis.com",
		"User-Agent: antigravity/1.5.15 linux/amd64",
		"Content-Length: 2",
		"Authorization: Bearer tok",
		"Content-Type: application/json",
		"Accept-Encoding: gzip",
		"",
		"",
	}, "\r\n")
	if got := <-rawHeadCh; got != want {
		t.Fatalf("wire head mismatch:\ngot:\n%q\nwant:\n%q", got, want)
	}
}

func startTLSUpstream(t *testing.T, handler http.HandlerFunc) (int, *[]string) {
	t.Helper()
	cert := newTestCert(t, "daily-cloudcode-pa.googleapis.com")
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var seen []string
	var mu sync.Mutex
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		handler(w, r)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port, &seen
}

func TestHTTPConnectProxyAuthAndPoolIsolation(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	upPort, _ := startTLSUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Errorf("Proxy-Authorization leaked to upstream")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"via":"http"}`))
	})

	var mu sync.Mutex
	var connects []string
	proxyLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer proxyLn.Close()
	proxySrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		mu.Lock()
		connects = append(connects, r.RequestURI+"|"+r.Header.Get("Proxy-Authorization"))
		mu.Unlock()
		_, port, _ := net.SplitHostPort(r.RequestURI)
		target, err := net.Dial("tcp", "127.0.0.1:"+port)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		hj, _ := w.(http.Hijacker)
		client, _, _ := hj.Hijack()
		_, _ = io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go func() { io.Copy(target, client); target.Close() }()
		go func() { io.Copy(client, target); client.Close() }()
	})}
	go proxySrv.Serve(proxyLn)
	defer proxySrv.Close()

	srv, _ := startTestSidecar(t)
	proxyPort := proxyLn.Addr().(*net.TCPAddr).Port
	targetURL := fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", upPort)
	proxyA := fmt.Sprintf("http://alice:s3cr%%40t@127.0.0.1:%d", proxyPort)
	proxyB := fmt.Sprintf("http://bob:other@127.0.0.1:%d", proxyPort)

	for _, tc := range []struct {
		proxy string
		tok   string
	}{
		{proxyA, "Bearer a1"},
		{proxyA, "Bearer a2"}, // reuses proxyA tunnel
		{proxyB, "Bearer b1"}, // isolated pool -> opens second tunnel
	} {
		resp := postWire(t, srv.URL, testToken, map[string]any{
			"url":         targetURL,
			"method":      "POST",
			"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Authorization", tc.tok}, {"Content-Length", "2"}},
			"proxyUrl":    tc.proxy,
			"insecureTls": true,
		}, "{}")
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(body) != `{"via":"http"}` {
			t.Fatalf("unexpected response: %d %s", resp.StatusCode, body)
		}
		if got := resp.Header.Get("X-9r-Proxy-Via"); got != fmt.Sprintf("http://127.0.0.1:%d", proxyPort) {
			t.Fatalf("X-9r-Proxy-Via = %q", got)
		}
		if got := resp.Header.Get("X-Agwire-Backend"); got != "go-crypto-tls" {
			t.Fatalf("X-Agwire-Backend = %q", got)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if len(connects) != 2 {
		t.Fatalf("CONNECT count = %d, want 2 (%v)", len(connects), connects)
	}
	wantA := fmt.Sprintf("daily-cloudcode-pa.googleapis.com:%d|Basic %s", upPort, base64.StdEncoding.EncodeToString([]byte("alice:s3cr@t")))
	wantB := fmt.Sprintf("daily-cloudcode-pa.googleapis.com:%d|Basic %s", upPort, base64.StdEncoding.EncodeToString([]byte("bob:other")))
	if connects[0] != wantA || connects[1] != wantB {
		t.Fatalf("connects = %v", connects)
	}
}

func TestSOCKS5hAndSOCKS4aProxies(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	upPort, _ := startTLSUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	// Minimal SOCKS5h server requiring RFC 1929 username/password auth.
	s5Ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer s5Ln.Close()
	s5Seen := make(chan string, 1)
	go func() {
		c, err := s5Ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		var g [2]byte
		io.ReadFull(br, g[:])
		io.CopyN(io.Discard, br, int64(g[1]))
		c.Write([]byte{0x05, 0x02})
		var ah [2]byte
		io.ReadFull(br, ah[:])
		u := make([]byte, ah[1])
		io.ReadFull(br, u)
		pl, _ := br.ReadByte()
		p := make([]byte, pl)
		io.ReadFull(br, p)
		c.Write([]byte{0x01, 0x00})
		var rh [4]byte
		io.ReadFull(br, rh[:])
		hl, _ := br.ReadByte()
		host := make([]byte, hl)
		io.ReadFull(br, host)
		var pb [2]byte
		io.ReadFull(br, pb[:])
		port := binary.BigEndian.Uint16(pb[:])
		s5Seen <- fmt.Sprintf("%s:%s@%s:%d", u, p, host, port)
		target, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return
		}
		defer target.Close()
		c.Write([]byte{0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0})
		go io.Copy(target, br)
		io.Copy(c, target)
	}()

	// Minimal SOCKS4a server.
	s4Ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer s4Ln.Close()
	s4Seen := make(chan string, 1)
	go func() {
		c, err := s4Ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		var hdr [8]byte
		io.ReadFull(br, hdr[:])
		port := binary.BigEndian.Uint16(hdr[2:4])
		user, _ := br.ReadString(0)
		host, _ := br.ReadString(0)
		s4Seen <- fmt.Sprintf("%s@%s:%d", strings.TrimSuffix(user, "\x00"), strings.TrimSuffix(host, "\x00"), port)
		target, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return
		}
		defer target.Close()
		c.Write([]byte{0x00, 0x5a, 0, 0, 0, 0, 0, 0})
		go io.Copy(target, br)
		io.Copy(c, target)
	}()

	srv, _ := startTestSidecar(t)
	targetURL := fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", upPort)

	s5Port := s5Ln.Addr().(*net.TCPAddr).Port
	r5 := postWire(t, srv.URL, testToken, map[string]any{
		"url":         targetURL,
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"proxyUrl":    fmt.Sprintf("socks5h://suser:spass@127.0.0.1:%d", s5Port),
		"insecureTls": true,
	}, "{}")
	r5.Body.Close()
	if r5.StatusCode != 200 || r5.Header.Get("X-9r-Proxy-Via") != fmt.Sprintf("socks5h://127.0.0.1:%d", s5Port) {
		t.Fatalf("socks5h failed: %d via=%q", r5.StatusCode, r5.Header.Get("X-9r-Proxy-Via"))
	}
	if got := <-s5Seen; got != fmt.Sprintf("suser:spass@daily-cloudcode-pa.googleapis.com:%d", upPort) {
		t.Fatalf("socks5h target = %q", got)
	}

	s4Port := s4Ln.Addr().(*net.TCPAddr).Port
	r4 := postWire(t, srv.URL, testToken, map[string]any{
		"url":         targetURL,
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"proxyUrl":    fmt.Sprintf("socks4a://u4@127.0.0.1:%d", s4Port),
		"insecureTls": true,
	}, "{}")
	r4.Body.Close()
	if r4.StatusCode != 200 || r4.Header.Get("X-9r-Proxy-Via") != fmt.Sprintf("socks4a://127.0.0.1:%d", s4Port) {
		t.Fatalf("socks4a failed: %d via=%q", r4.StatusCode, r4.Header.Get("X-9r-Proxy-Via"))
	}
	if got := <-s4Seen; got != fmt.Sprintf("u4@daily-cloudcode-pa.googleapis.com:%d", upPort) {
		t.Fatalf("socks4a target = %q", got)
	}
}

func TestNoDirectFallbackAndNoCredentialLeak(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	upPort, seen := startTLSUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("should-not-reach"))
	})
	deadLn, _ := net.Listen("tcp", "127.0.0.1:0")
	deadPort := deadLn.Addr().(*net.TCPAddr).Port
	deadLn.Close()

	srv, _ := startTestSidecar(t)
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", upPort),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"proxyUrl":    fmt.Sprintf("http://secretuser:secretpass@127.0.0.1:%d", deadPort),
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "{}")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	if strings.Contains(string(body), "secretuser") || strings.Contains(string(body), "secretpass") {
		t.Fatalf("proxy credentials leaked in error: %s", body)
	}
	if len(*seen) != 0 {
		t.Fatalf("upstream was reached directly despite proxy failure")
	}
}

func TestValidationAuthSSRFAndCRLF(t *testing.T) {
	srv, _ := startTestSidecar(t)

	// Wrong token -> 403
	r := postWire(t, srv.URL, "wrong", map[string]any{"url": "https://daily-cloudcode-pa.googleapis.com/x", "method": "POST"}, "{}")
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("bad token status = %d, want 403", r.StatusCode)
	}
	if got := r.Header.Get("X-Agwire-Backend"); got != "" {
		t.Fatalf("error response must not set X-Agwire-Backend, got %q", got)
	}

	// Non-POST -> 405
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/wire", nil)
	req.Header.Set("X-Agwire-Token", testToken)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", r.StatusCode)
	}

	// SSRF + CRLF + malformed headers -> 400
	badMetas := []map[string]any{
		{"url": "https://127.0.0.1/secret", "method": "POST"},
		{"url": "https://evil.example.com/x", "method": "POST"},
		{"url": "http://daily-cloudcode-pa.googleapis.com/x", "method": "POST"},
		{"url": "https://u:p@daily-cloudcode-pa.googleapis.com/x", "method": "POST"},
		{"url": "https://daily-cloudcode-pa.googleapis.com/x", "method": "POST\r\nEvil: 1"},
		{"url": "https://daily-cloudcode-pa.googleapis.com/x", "method": "POST", "headers": [][]string{{"X-Test", "ok\r\nInjected: 1"}}},
		{"url": "https://daily-cloudcode-pa.googleapis.com/x", "method": "POST", "headers": [][]string{{"Bad Header", "v"}}},
		{"url": "https://daily-cloudcode-pa.googleapis.com/x", "method": "POST", "headers": [][]string{{"OnlyName"}}},
		{"url": "https://daily-cloudcode-pa.googleapis.com/x", "method": "POST", "proxyUrl": "http://u%0d%0a:p@127.0.0.1:8080"},
	}
	for i, meta := range badMetas {
		resp := postWire(t, srv.URL, testToken, meta, "{}")
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("case %d status = %d, want 400 (%v)", i, resp.StatusCode, meta)
		}
	}
}

func TestStreamingSSEFlushGzipDeflateAndStaleRetry(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	cert := newTestCert(t, "daily-cloudcode-pa.googleapis.com")

	// 1. Streaming SSE flush: server waits for client to read chunk 1 before sending chunk 2.
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	chunk1Read := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		http.ReadRequest(br)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
		c1 := "data: {\"chunk\":1}\n\n"
		_, _ = fmt.Fprintf(conn, "%x\r\n%s\r\n", len(c1), c1)
		<-chunk1Read
		c2 := "data: {\"chunk\":2}\n\n"
		_, _ = fmt.Fprintf(conn, "%x\r\n%s\r\n0\r\n\r\n", len(c2), c2)
	}()

	srv, _ := startTestSidecar(t)
	port := ln.Addr().(*net.TCPAddr).Port
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:streamGenerateContent", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "{}")
	defer resp.Body.Close()

	buf := make([]byte, 256)
	n, err := resp.Body.Read(buf)
	if err != nil || !strings.Contains(string(buf[:n]), `"chunk":1`) {
		t.Fatalf("first SSE chunk not flushed immediately: n=%d err=%v got=%q", n, err, buf[:n])
	}
	close(chunk1Read)
	rest, _ := io.ReadAll(resp.Body)
	if full := string(buf[:n]) + string(rest); full != "data: {\"chunk\":1}\n\ndata: {\"chunk\":2}\n\n" {
		t.Fatalf("full SSE = %q", full)
	}

	// 2. Gzip + Deflate + Stale pooled socket retry.
	var reqCount int
	var mu sync.Mutex
	upLn, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer upLn.Close()
	go func() {
		for {
			conn, err := upLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				req, err := http.ReadRequest(br)
				if err != nil {
					return
				}
				io.Copy(io.Discard, req.Body)
				mu.Lock()
				reqCount++
				n := reqCount
				mu.Unlock()
				var payload bytes.Buffer
				if n == 1 {
					gw := gzip.NewWriter(&payload)
					gw.Write([]byte(`{"enc":"gzip"}`))
					gw.Close()
					fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: %d\r\n\r\n", payload.Len())
					c.Write(payload.Bytes())
					// Close immediately after sending so the parked socket is stale on req 2.
					return
				}
				zw := zlib.NewWriter(&payload)
				zw.Write([]byte(`{"enc":"deflate"}`))
				zw.Close()
				fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Encoding: deflate\r\nContent-Length: %d\r\n\r\n", payload.Len())
				c.Write(payload.Bytes())
			}(conn)
		}
	}()

	upPort := upLn.Addr().(*net.TCPAddr).Port
	u := fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", upPort)
	r1 := postWire(t, srv.URL, testToken, map[string]any{
		"url": u, "method": "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"insecureTls": true, "connectHost": "127.0.0.1",
	}, "{}")
	b1, _ := io.ReadAll(r1.Body)
	r1.Body.Close()
	if string(b1) != `{"enc":"gzip"}` || r1.Header.Get("Content-Encoding") != "" {
		t.Fatalf("gzip decode failed: %q enc=%q", b1, r1.Header.Get("Content-Encoding"))
	}

	// Give the server goroutine a moment to close the parked socket so req 2 hits stale retry.
	time.Sleep(20 * time.Millisecond)
	r2 := postWire(t, srv.URL, testToken, map[string]any{
		"url": u, "method": "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"insecureTls": true, "connectHost": "127.0.0.1",
	}, "{}")
	b2, _ := io.ReadAll(r2.Body)
	r2.Body.Close()
	if r2.StatusCode != 200 || string(b2) != `{"enc":"deflate"}` {
		t.Fatalf("stale retry / deflate failed: %d %q", r2.StatusCode, b2)
	}
}

func TestHTTP2ALPNAndHeadNoBody(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	cert := newTestCert(t, "daily-cloudcode-pa.googleapis.com")

	h2Srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Proto", r.Proto)
		_, _ = w.Write([]byte(`{"h2":true}`))
	}))
	h2Srv.EnableHTTP2 = true
	h2Srv.TLS = &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h2", "http/1.1"},
	}
	h2Srv.StartTLS()
	defer h2Srv.Close()

	srv, _ := startTestSidecar(t)
	_, portStr, _ := net.SplitHostPort(strings.TrimPrefix(h2Srv.URL, "https://"))
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%s/v1internal:loadCodeAssist", portStr),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"alpn":        []string{"h2", "http/1.1"},
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "{}")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != `{"h2":true}` {
		t.Fatalf("h2 failed: %d %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Proto"); got != "HTTP/2.0" {
		t.Fatalf("upstream proto = %q, want HTTP/2.0", got)
	}
	if got := resp.Header.Get("X-Agwire-Backend"); got != "go-crypto-tls" {
		t.Fatalf("X-Agwire-Backend = %q", got)
	}

	// HEAD with Content-Encoding: gzip must not fail trying to gunzip an empty body.
	upPort, _ := startTLSUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(http.StatusNoContent)
	})
	rHead := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", upPort),
		"method":      "HEAD",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}},
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "")
	rHead.Body.Close()
	if rHead.StatusCode != http.StatusNoContent {
		t.Fatalf("HEAD 204 status = %d, want 204", rHead.StatusCode)
	}
}

// Without AGWIRE_ALLOW_TEST_HOSTS=1 the test-only escapes (non-allowlisted host,
// insecureTls, connectHost) must all be inert — the SSRF guard runs first.
func TestTestOnlyFlagsIgnoredWithoutEnv(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "")
	upPort, seen := startTLSUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("should-not-connect"))
	})
	srv, _ := startTestSidecar(t)
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://127.0.0.1:%d/v1internal:loadCodeAssist", upPort),
		"method":      "POST",
		"headers":     [][]string{{"Host", "127.0.0.1"}, {"Content-Length", "2"}},
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "{}")
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (host not allowlisted)", resp.StatusCode)
	}
	if got := resp.Header.Get("X-Agwire-Backend"); got != "" {
		t.Fatalf("error response must not set X-Agwire-Backend, got %q", got)
	}
	if len(*seen) != 0 {
		t.Fatalf("upstream reached despite a non-allowlisted host")
	}

	// Pin DNS so the SOCKS target IP proves which hostname was resolved: an
	// honored connectHost would dial 127.0.0.1 instead.
	remember("daily-cloudcode-pa.googleapis.com", "192.0.2.1")
	// Even for an allowlisted host, connectHost must be ignored without AGWIRE_ALLOW_TEST_HOSTS=1.
	s5Ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer s5Ln.Close()
	s5AddrCh := make(chan string, 1)
	go func() {
		c, err := s5Ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		var g [2]byte
		io.ReadFull(br, g[:])
		io.CopyN(io.Discard, br, int64(g[1]))
		c.Write([]byte{0x05, 0x00})
		var req [4]byte
		io.ReadFull(br, req[:])
		if req[3] == 0x01 {
			var ip [4]byte
			io.ReadFull(br, ip[:])
			s5AddrCh <- net.IP(ip[:]).String()
		}
		c.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	}()
	r2 := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", upPort),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"proxyUrl":    fmt.Sprintf("socks5://127.0.0.1:%d", s5Ln.Addr().(*net.TCPAddr).Port),
		"insecureTls": true,
		"connectHost": "127.0.0.1",
	}, "{}")
	r2.Body.Close()
	select {
	case gotIP := <-s5AddrCh:
		if gotIP != "192.0.2.1" {
			t.Fatalf("SOCKS target = %s, want resolved IP (connectHost must be ignored)", gotIP)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("SOCKS proxy never received a connect request")
	}
}

func startRawTLS(t *testing.T, handle func(conn net.Conn, req *http.Request, body []byte)) (port int, connCount *int32) {
	t.Helper()
	cert := newTestCert(t, "daily-cloudcode-pa.googleapis.com")
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var n int32
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			atomic.AddInt32(&n, 1)
			go func(c net.Conn) {
				defer c.Close()
				req, err := http.ReadRequest(bufio.NewReader(c))
				if err != nil {
					return
				}
				var body []byte
				if req.Body != nil {
					body, _ = io.ReadAll(req.Body)
					_ = req.Body.Close()
				}
				handle(c, req, body)
			}(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, &n
}

// A body with no Content-Length header must still be framed, or the upstream
// reads the body bytes as the start of the next request.
func TestBodyWithoutContentLengthGetsFraming(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	heads := make(chan string, 1)
	port, _ := startRawTLS(t, func(conn net.Conn, req *http.Request, body []byte) {
		var head bytes.Buffer
		head.WriteString(req.Method + " " + req.URL.RequestURI() + " " + req.Proto + "\r\n")
		for name, values := range req.Header {
			for _, v := range values {
				head.WriteString(name + ": " + v + "\r\n")
			}
		}
		head.WriteString("\r\n" + string(body))
		heads <- head.String()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	})

	srv, _ := startTestSidecar(t)
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}},
		"connectHost": "127.0.0.1",
		"insecureTls": true,
		"allowReuse":  false,
	}, "{}")
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	got := <-heads
	if !strings.Contains(got, "Content-Length: 2") {
		t.Fatalf("missing framing header in %q", got)
	}
	if !strings.HasSuffix(got, "\r\n\r\n{}") {
		t.Fatalf("body not delivered intact: %q", got)
	}
}

// A caller-supplied Transfer-Encoding must never reach the upstream: framing is
// the sidecar's, and Node sends a raw (un-chunked) body.
func TestCallerTransferEncodingIsDropped(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	heads := make(chan http.Header, 1)
	port, _ := startRawTLS(t, func(conn net.Conn, req *http.Request, _ []byte) {
		heads <- req.Header.Clone()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	})
	srv, _ := startTestSidecar(t)
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Transfer-Encoding", "chunked"}, {"Content-Length", "2"}},
		"connectHost": "127.0.0.1",
		"insecureTls": true,
		"allowReuse":  false,
	}, "{}")
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	h := <-heads
	if got := h.Get("Transfer-Encoding"); got != "" {
		t.Fatalf("Transfer-Encoding leaked upstream: %q", got)
	}
	if got := h.Get("Content-Length"); got != "2" {
		t.Fatalf("Content-Length = %q, want 2", got)
	}
}

// Only an unanswered request may be retried. A partial response head proves the
// upstream received and answered it, so replaying would duplicate the turn.
func TestNoReplayAfterPartialResponseHead(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	var served int32
	port, _ := startRawTLS(t, func(conn net.Conn, req *http.Request, _ []byte) {
		n := atomic.AddInt32(&served, 1)
		if n == 1 {
			_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
			return
		}
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Le")
		time.Sleep(20 * time.Millisecond)
	})

	srv, _ := startTestSidecar(t)
	meta := map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:streamGenerateContent", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"connectHost": "127.0.0.1",
		"insecureTls": true,
	}
	first := postWire(t, srv.URL, testToken, meta, "{}")
	body, _ := io.ReadAll(first.Body)
	first.Body.Close()
	if first.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("first request failed: %d %q", first.StatusCode, body)
	}

	second := postWire(t, srv.URL, testToken, meta, "{}")
	second.Body.Close()
	if second.StatusCode != http.StatusBadGateway {
		t.Fatalf("partial head status = %d, want 502", second.StatusCode)
	}
	if got := atomic.LoadInt32(&served); got != 2 {
		t.Fatalf("upstream served %d requests, want 2 (no replay)", got)
	}
}

// Bytes left past the response body mean the connection is out of sync; parking
// it would hand those bytes to the next request as its response.
func TestTrailingBytesAreNotParked(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	port, connCount := startRawTLS(t, func(conn net.Conn, req *http.Request, _ []byte) {
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokSTALE-RESPONSE")
		time.Sleep(150 * time.Millisecond)
	})

	srv, _ := startTestSidecar(t)
	meta := map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"connectHost": "127.0.0.1",
		"insecureTls": true,
	}
	for i := 0; i < 2; i++ {
		resp := postWire(t, srv.URL, testToken, meta, "{}")
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(body) != "ok" {
			t.Fatalf("request %d: %d %q", i+1, resp.StatusCode, body)
		}
	}
	if got := atomic.LoadInt32(connCount); got != 2 {
		t.Fatalf("connections = %d, want 2 (desynced socket must not be reused)", got)
	}
}

func TestProxyURLCannotEvadeValidation(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	srv, _ := startTestSidecar(t)
	bad := postWire(t, srv.URL, testToken, map[string]any{
		"url":      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
		"method":   "POST",
		"proxyUrl": "http://127.0.0.1:99999",
	}, "{}")
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad proxy port status = %d, want 400", bad.StatusCode)
	}

	// An IPv6 literal is a valid proxy host and must reach the dialer, not 400.
	v6 := postWire(t, srv.URL, testToken, map[string]any{
		"url":      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
		"method":   "POST",
		"proxyUrl": "http://[::1]:1",
	}, "{}")
	v6.Body.Close()
	if v6.StatusCode == http.StatusBadRequest {
		t.Fatalf("IPv6 proxy host rejected as invalid")
	}
}

// A truncated upstream body must abort the Node-facing response, not look like a
// clean, shorter one.
func TestMidStreamTruncationAbortsResponse(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	port, _ := startRawTLS(t, func(conn net.Conn, req *http.Request, _ []byte) {
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhello")
	})
	srv, _ := startTestSidecar(t)
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:streamGenerateContent", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"connectHost": "127.0.0.1",
		"insecureTls": true,
		"allowReuse":  false,
	}, "{}")
	defer resp.Body.Close()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatalf("expected a read error on a truncated upstream body")
	}
}

func TestUpstreamCannotSpoofSidecarHeaders(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	upPort, _ := startTLSUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-9r-Proxy-Via", "http://spoofed-proxy:9999")
		w.Header().Set("X-Agwire-Backend", "spoofed-backend")
		_, _ = w.Write([]byte("ok"))
	})
	srv, _ := startTestSidecar(t)
	resp := postWire(t, srv.URL, testToken, map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", upPort),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"connectHost": "127.0.0.1",
		"insecureTls": true,
	}, "{}")
	resp.Body.Close()
	if got := resp.Header.Get("X-9r-Proxy-Via"); got != "" {
		t.Fatalf("direct response leaked spoofed X-9r-Proxy-Via = %q", got)
	}
	if got := resp.Header.Get("X-Agwire-Backend"); got != "go-crypto-tls" {
		t.Fatalf("X-Agwire-Backend = %q, want go-crypto-tls", got)
	}
}

// The h2 path must forward the caller's User-Agent and never emit Go's default.
func TestHTTP2UserAgentHandling(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	cert := newTestCert(t, "daily-cloudcode-pa.googleapis.com")
	var seenUA []string
	var mu sync.Mutex
	h2Srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seenUA = append(seenUA, r.Header.Get("User-Agent"))
		mu.Unlock()
		_, _ = w.Write([]byte("ok"))
	}))
	h2Srv.EnableHTTP2 = true
	h2Srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"h2", "http/1.1"}}
	h2Srv.StartTLS()
	defer h2Srv.Close()

	srv, _ := startTestSidecar(t)
	_, portStr, _ := net.SplitHostPort(strings.TrimPrefix(h2Srv.URL, "https://"))
	u := fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%s/v1internal:loadCodeAssist", portStr)

	r1 := postWire(t, srv.URL, testToken, map[string]any{
		"url": u, "method": "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "2"}},
		"alpn":        []string{"h2", "http/1.1"},
		"insecureTls": true, "connectHost": "127.0.0.1",
	}, "{}")
	r1.Body.Close()

	r2 := postWire(t, srv.URL, testToken, map[string]any{
		"url": u, "method": "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"User-Agent", "antigravity/1.5.15"}, {"Content-Length", "2"}},
		"alpn":        []string{"h2", "http/1.1"},
		"insecureTls": true, "connectHost": "127.0.0.1",
	}, "{}")
	r2.Body.Close()

	mu.Lock()
	defer mu.Unlock()
	if len(seenUA) != 2 || seenUA[0] != "" || seenUA[1] != "antigravity/1.5.15" {
		t.Fatalf("seenUA = %q, want [\"\" \"antigravity/1.5.15\"]", seenUA)
	}
}

// An oversized (live-streamed) body has no buffered length: it must still reach
// the upstream intact, framed with chunked encoding.
func TestLargeStreamedRequestBody(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "1")
	gotLen := make(chan int, 1)
	port, _ := startRawTLS(t, func(conn net.Conn, req *http.Request, body []byte) {
		gotLen <- len(body)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	})
	srv, _ := startTestSidecar(t)
	big := strings.Repeat("a", maxBufferedBody+4096)
	metaBytes, _ := json.Marshal(map[string]any{
		"url":         fmt.Sprintf("https://daily-cloudcode-pa.googleapis.com:%d/v1internal:loadCodeAssist", port),
		"method":      "POST",
		"headers":     [][]string{{"Host", "daily-cloudcode-pa.googleapis.com"}, {"Content-Length", "0"}},
		"connectHost": "127.0.0.1",
		"insecureTls": true,
		"allowReuse":  false,
	})
	pr, pw := io.Pipe()
	go func() {
		_, _ = io.WriteString(pw, big)
		_ = pw.Close()
	}()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/wire", pr)
	req.ContentLength = -1
	req.Header.Set("X-Agwire-Token", testToken)
	req.Header.Set("X-Agwire-Meta", string(metaBytes))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if n := <-gotLen; n != len(big) {
		t.Fatalf("upstream received %d bytes, want %d", n, len(big))
	}
}

func TestSSRFHostEdgeCases(t *testing.T) {
	t.Setenv("AGWIRE_ALLOW_TEST_HOSTS", "")
	srv, _ := startTestSidecar(t)
	for _, u := range []string{
		"https://daily-cloudcode-pa.googleapis.com./v1internal:loadCodeAssist",
		"https://:443/v1internal:loadCodeAssist",
		"https://[::1]/v1internal:loadCodeAssist",
	} {
		resp := postWire(t, srv.URL, testToken, map[string]any{"url": u, "method": "POST"}, "{}")
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("url %q status = %d, want 400", u, resp.StatusCode)
		}
	}
}
