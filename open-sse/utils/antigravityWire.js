/**
 * Wire-level sender for Antigravity's Cloud Code endpoints.
 *
 * The native client is Go's net/http speaking HTTP/1.1 with exactly six
 * headers (captured 2026-11-23 from agy 1.5.14):
 *
 *   Host, User-Agent, Content-Length, Authorization, Content-Type, Accept-Encoding
 *
 * No `Connection`, no `Transfer-Encoding: chunked`, no `Accept`,
 * no `Accept-Language`, no `Sec-Fetch-*`. Node's `http.request` always emits a
 * `Connection` header and undici's fetch layer adds three browser headers, so
 * neither can reproduce that wire. This module writes the request bytes itself
 * over a TLS socket and reads the response back, which makes the header set and
 * order exactly what the fingerprint snapshot says.
 *
 * Proxy pools (`http://`, `https://`, `socks4/4a/5/5h://`) tunnel through the
 * same wire sender (`directFetch.proxyCapable = true`), so proxied accounts
 * emit the exact same six headers inside the TLS tunnel.
 *
 * The preferred transport is the `agwire` Go sidecar (`go/agwire`): Go's
 * crypto/tls reproduces `agy`'s ClientHello byte-for-byte, extension order
 * included. Node's own TLS sender is the fallback. undici is never a fallback:
 * a wire failure is surfaced as an error instead of silently shipping the
 * browser-shaped fetch fingerprint.
 */

import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough, Readable } from "node:stream";
import { getFingerprint, buildUserAgent, startFingerprintSync } from "../services/antigravityFingerprint.js";
import { proxyAwareFetch } from "./proxyFetch.js";
import { setBounded } from "./boundedMap.js";

const MODULE_DIR = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

const ANTIGRAVITY_HOSTS = new Set([
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "aicode.googleapis.com",
]);

const CANONICAL_HEADER_NAMES = {
  host: "Host",
  "user-agent": "User-Agent",
  "content-length": "Content-Length",
  authorization: "Authorization",
  "content-type": "Content-Type",
  "accept-encoding": "Accept-Encoding",
};

const CONNECT_TIMEOUT_MS = 20_000;
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_IDLE_PER_ORIGIN = 8;
const IDLE_SOCKET_TIMEOUT_MS = 60_000;
// Only an explicit override is passed to `tls.connect`. Node 24's default list
// already leads with X25519MLKEM768 + X25519 (0x11ec, 0x001d) — exactly the
// key shares `agy` offers. Forcing one curve rewrites that ClientHello.
function getEcdhCurve() {
  return process.env.NINEROUTER_TLS_ECDH_CURVE || null;
}

/** `${origin}::${proxyPoolKey}` -> idle sockets[]. */
const idleSockets = new Map();
const dnsCache = new Map();
const MAX_CONNECT_HEAD_BYTES = 16 * 1024;
const MAX_RESPONSE_HEAD_BYTES = 64 * 1024;
const SIDECAR_START_TIMEOUT_MS = 5_000;
const MAX_SIDECAR_STARTUP_BYTES = 16 * 1024;
const AGWIRE_BIN_NAME = process.platform === "win32" ? "agwire.exe" : "agwire";
// A pre-connect failure is the only proof the sidecar never received the request.
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED", "ENOENT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ECONNABORTED",
]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);

function safeProxyLabel(proxyUrl) {
  try {
    const parsed = new URL(String(proxyUrl));
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "proxy";
  }
}

function proxyPoolKey(proxyUrl) {
  if (!proxyUrl) return "direct";
  return crypto.createHash("sha256").update(String(proxyUrl)).digest("hex").slice(0, 16);
}

export function isAntigravityHost(hostname) {
  return ANTIGRAVITY_HOSTS.has(String(hostname || "").toLowerCase());
}

function canonicalHeaderName(name) {
  const lower = String(name || "").toLowerCase();
  return CANONICAL_HEADER_NAMES[lower] || name;
}

/** AbortError matches BaseExecutor's cancellation check so aborted turns are not retried. */
function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/** Reject bytes that would split the request head or smuggle a header. */
function assertSafeToken(value, label) {
  const text = String(value ?? "");
  if (/[\r\n\0]/.test(text)) throw new Error(`antigravity wire: invalid ${label}`);
  return text;
}

function assertValidHttpMethod(method) {
  const upper = assertSafeToken(method || "POST", "method").toUpperCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(upper)) {
    throw new Error("antigravity wire: invalid method");
  }
  return upper;
}

function assertValidHeaderName(name) {
  const safe = assertSafeToken(name, "header name");
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(safe)) {
    throw new Error(`antigravity wire: invalid header name`);
  }
  return safe;
}

/** `agy` pins HTTP/1.1 on Cloud Code; h2 is only offered when a capture saw it. */
function alpnProtocolsFor(alpnProtocol) {
  return String(alpnProtocol || "").toLowerCase() === "h2" ? ["h2", "http/1.1"] : ["http/1.1"];
}

/**
 * Ordered header list from the fingerprint snapshot. Values we cannot know are
 * omitted rather than invented; unknown snapshot headers are skipped so a
 * capture from a newer binary never ships a malformed request.
 */
export function buildAntigravityHeaders({ url, method = "POST", token, bodyLength, fp = getFingerprint({ probe: false }) }) {
  assertSafeToken(url, "url");
  const parsed = new URL(url);
  const upperMethod = assertValidHttpMethod(method);
  const authToken = token == null ? null : assertSafeToken(token, "token");
  const hasBody = (bodyLength ?? 0) > 0 || (upperMethod !== "GET" && upperMethod !== "HEAD");
  const values = {
    host: parsed.host,
    "user-agent": buildUserAgent(fp),
    "content-length": hasBody ? String(bodyLength ?? 0) : undefined,
    authorization: authToken ? `Bearer ${authToken}` : undefined,
    "content-type": hasBody ? "application/json" : undefined,
    "accept-encoding": "gzip",
  };
  const headerList = (fp.streamHeaders && parsed.pathname.includes("streamGenerateContent"))
    ? fp.streamHeaders
    : fp.headers;
  const out = [];
  for (const name of headerList || []) {
    const lower = String(name).toLowerCase();
    const value = values[lower];
    if (value === undefined) continue;
    out.push([assertValidHeaderName(canonicalHeaderName(lower)), assertSafeToken(value, `header ${lower}`)]);
  }
  return out;
}

/** Plain object view of the ordered headers (for BaseExecutor / fallback compatibility). */
export function buildAntigravityHeaderObject(opts) {
  const obj = {};
  for (const [name, value] of buildAntigravityHeaders(opts)) {
    obj[name] = value;
  }
  return obj;
}

function isLoopbackIp(ip) {
  return ip === "::1" || ip.startsWith("127.");
}

async function resolveConnectHost(hostname) {
  if (net.isIP(hostname)) return hostname;
  const cached = dnsCache.get(hostname);
  if (cached) {
    if (Date.now() < cached.expiry) return cached.ip;
    dnsCache.delete(hostname);
  }

  try {
    const sys = await dns.promises.lookup(hostname, { family: 4 });
    if (sys?.address && !isLoopbackIp(sys.address)) {
      setBounded(dnsCache, hostname, { ip: sys.address, expiry: Date.now() + DNS_CACHE_TTL_MS }, 200);
      return sys.address;
    }
  } catch { /* fall through to Google DNS */ }

  try {
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8", "8.8.4.4"]);
    const addrs = await new Promise((resolve, reject) => {
      resolver.resolve4(hostname, (err, res) => (err ? reject(err) : resolve(res)));
    });
    if (addrs?.[0]) {
      setBounded(dnsCache, hostname, { ip: addrs[0], expiry: Date.now() + DNS_CACHE_TTL_MS }, 200);
      return addrs[0];
    }
  } catch { /* fall back to hostname */ }

  return hostname;
}

function validateProxyUrl(proxyUrl) {
  if (/[\r\n\0]/.test(String(proxyUrl))) throw new Error("proxy CONNECT: invalid proxy URL");
  const parsed = new URL(proxyUrl);
  if (parsed.username || parsed.password) {
    let creds;
    try {
      creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    } catch {
      throw new Error(`proxy CONNECT ${safeProxyLabel(proxyUrl)}: malformed credentials`);
    }
    if (/[\r\n\0]/.test(creds)) throw new Error(`proxy CONNECT ${safeProxyLabel(proxyUrl)}: invalid credentials`);
    return { parsed, creds };
  }
  return { parsed, creds: null };
}

function connectViaHttpProxy(proxyUrl, targetHost, targetPort, signal) {
  const { parsed, creds } = validateProxyUrl(proxyUrl);
  const isTlsProxy = parsed.protocol === "https:";
  const proxyHost = parsed.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = Number(parsed.port || (isTlsProxy ? 443 : 80));
  const authority = net.isIPv6(targetHost) ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
  const proxyAuth = creds !== null ? `Basic ${Buffer.from(creds).toString("base64")}` : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const ecdhCurve = getEcdhCurve();
    const rawSocket = isTlsProxy
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost, ALPNProtocols: ["http/1.1"], ...(ecdhCurve ? { ecdhCurve } : {}) })
      : net.connect({ host: proxyHost, port: proxyPort });
    rawSocket.setNoDelay(true);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rawSocket.destroy();
      reject(err);
    };
    const onAbort = () => fail(abortError());
    const timer = setTimeout(() => fail(new Error(`proxy CONNECT ${safeProxyLabel(proxyUrl)} timeout`)), CONNECT_TIMEOUT_MS);
    timer.unref?.();

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_CONNECT_HEAD_BYTES) {
        fail(new Error(`proxy CONNECT ${safeProxyLabel(proxyUrl)} response too large`));
        return;
      }
      const split = buf.indexOf("\r\n\r\n");
      if (split < 0) return;
      const head = buf.subarray(0, split).toString("latin1");
      const statusLine = head.split("\r\n")[0] || "";
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
      const status = match ? Number(match[1]) : 0;
      if (status !== 200) {
        fail(new Error(`proxy CONNECT ${safeProxyLabel(proxyUrl)} failed: HTTP ${status || "invalid"}`));
        return;
      }
      settled = true;
      cleanup();
      rawSocket.pause();
      const extra = buf.subarray(split + 4);
      if (extra.length > 0) rawSocket.unshift(extra);
      resolve(rawSocket);
    };
    const onEnd = () => fail(new Error(`proxy CONNECT ${safeProxyLabel(proxyUrl)} closed early`));
    const onError = (err) => fail(err);
    const onReady = () => {
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
      if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
      lines.push("", "");
      rawSocket.write(lines.join("\r\n"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      rawSocket.off("data", onData);
      rawSocket.off("end", onEnd);
      rawSocket.off("error", onError);
      rawSocket.off(isTlsProxy ? "secureConnect" : "connect", onReady);
    };

    if (signal) {
      if (signal.aborted) { fail(abortError()); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    rawSocket.on("data", onData);
    rawSocket.once("end", onEnd);
    rawSocket.once("error", onError);
    rawSocket.once(isTlsProxy ? "secureConnect" : "connect", onReady);
  });
}

async function connectViaSocksProxy(proxyUrl, targetHost, targetPort, signal) {
  if (signal?.aborted) throw abortError();
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  const agent = new SocksProxyAgent(proxyUrl);
  let timer;
  let onAbort;
  const connectPromise = agent.connect({ destroy() {} }, { host: targetHost, port: targetPort, secureEndpoint: false });
  const guardPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SOCKS proxy ${safeProxyLabel(proxyUrl)} timeout`)), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    if (signal) {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  let socket;
  try {
    socket = await Promise.race([connectPromise, guardPromise]);
  } catch (err) {
    connectPromise.then((s) => { try { s?.destroy(); } catch { /* ignore */ } }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
  socket.setTimeout(0);
  socket.removeAllListeners("timeout");
  socket.setNoDelay(true);
  return socket;
}

async function openTunnelSocket(proxyUrl, targetHost, targetPort, signal) {
  const { parsed } = validateProxyUrl(proxyUrl);
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === "http:" || scheme === "https:") {
    return connectViaHttpProxy(proxyUrl, targetHost, targetPort, signal);
  }
  if (scheme.startsWith("socks")) {
    return connectViaSocksProxy(proxyUrl, targetHost, targetPort, signal);
  }
  throw new Error(`unsupported proxy scheme: ${scheme}`);
}

async function connect(host, port, tlsOptions = null, proxyUrl = null, signal = null) {
  if (signal?.aborted) throw abortError();
  let tunnelSocket = null;
  let connectHost = host;
  if (proxyUrl) {
    tunnelSocket = await openTunnelSocket(proxyUrl, host, port, signal);
  } else {
    connectHost = tlsOptions?.connectHost || await resolveConnectHost(host);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const tlsOpts = { ...(tlsOptions || {}) };
    const tlsAlpn = tlsOpts.alpnProtocol;
    delete tlsOpts.alpnProtocol;
    delete tlsOpts.connectHost;
    const ecdhCurve = getEcdhCurve();
    const socket = tls.connect({
      ...(tunnelSocket ? { socket: tunnelSocket } : { host: connectHost, port }),
      servername: host,
      ALPNProtocols: alpnProtocolsFor(tlsAlpn),
      ...(ecdhCurve ? { ecdhCurve } : {}),
      ...tlsOpts,
    });
    socket.setNoDelay(true);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      if (tunnelSocket) tunnelSocket.destroy();
      reject(error);
    };
    const onAbort = () => fail(abortError());
    const timer = setTimeout(() => fail(new Error("antigravity wire connect timeout")), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    const onError = (error) => fail(error);
    const onSecure = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      socket.off("secureConnect", onSecure);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once("secureConnect", onSecure);
  });
}

function takeIdleSocket(origin) {
  const pool = idleSockets.get(origin);
  if (!pool || pool.length === 0) return null;
  while (pool.length > 0) {
    const socket = pool.pop();
    if (socket && !socket.destroyed && socket.writable) {
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      socket.removeAllListeners("timeout");
      socket.setTimeout(0);
      socket.ref?.();
      return socket;
    }
  }
  return null;
}

function parkIdleSocket(origin, socket) {
  if (!socket || socket.destroyed || !socket.writable) return;
  let pool = idleSockets.get(origin);
  if (!pool) {
    pool = [];
    idleSockets.set(origin, pool);
  }
  while (pool.length >= MAX_IDLE_PER_ORIGIN) {
    const evicted = pool.shift();
    try { evicted?.destroy(); } catch { /* ignore */ }
  }
  const drop = () => {
    const idx = pool.indexOf(socket);
    if (idx >= 0) pool.splice(idx, 1);
    if (pool.length === 0 && idleSockets.get(origin) === pool) idleSockets.delete(origin);
    try { socket.destroy(); } catch { /* ignore */ }
  };
  socket.removeAllListeners("data");
  socket.removeAllListeners("end");
  socket.removeAllListeners("error");
  socket.once("error", drop);
  socket.once("close", drop);
  socket.setTimeout(IDLE_SOCKET_TIMEOUT_MS, drop);
  socket.unref?.();
  pool.push(socket);
}

function readHead(socket, bufferRef) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      bufferRef.data = Buffer.concat([bufferRef.data, chunk]);
      const idx = bufferRef.data.indexOf("\r\n\r\n");
      if (idx < 0) {
        if (bufferRef.data.length > MAX_RESPONSE_HEAD_BYTES) {
          cleanup();
          socket.destroy();
          const err = new Error(`antigravity wire response head exceeded ${MAX_RESPONSE_HEAD_BYTES} bytes`);
          err.receivedAny = true;
          reject(err);
        }
        return;
      }
      if (idx > MAX_RESPONSE_HEAD_BYTES) {
        cleanup();
        socket.destroy();
        const err = new Error(`antigravity wire response head exceeded ${MAX_RESPONSE_HEAD_BYTES} bytes`);
        err.receivedAny = true;
        reject(err);
        return;
      }
      cleanup();
      const head = bufferRef.data.subarray(0, idx).toString("latin1");
      bufferRef.data = bufferRef.data.subarray(idx + 4);
      const [statusLine, ...headerLines] = head.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      if (!Number.isInteger(status) || status < 100 || status > 999) {
        const err = new Error("antigravity wire: invalid HTTP status line");
        err.receivedAny = true;
        reject(err);
        return;
      }
      const headers = {};
      for (const line of headerLines) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status, headers, statusLine });
    };
    const onEnd = () => {
      cleanup();
      const err = new Error("socket closed before response headers");
      err.receivedAny = bufferRef.data.length > 0;
      reject(err);
    };
    const onError = (error) => {
      cleanup();
      if (error && typeof error === "object") error.receivedAny = bufferRef.data.length > 0;
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    if (bufferRef.data.length > 0) onData(Buffer.alloc(0));
  });
}

/** Decode `Transfer-Encoding: chunked` incrementally. */
function createChunkDecoder() {
  let buffer = Buffer.alloc(0);
  let remaining = -1;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const out = [];
    while (true) {
      if (remaining >= 0) {
        if (buffer.length < remaining + 2) break;
        out.push(buffer.subarray(0, remaining));
        buffer = buffer.subarray(remaining + 2);
        remaining = -1;
        continue;
      }
      const lineEnd = buffer.indexOf("\r\n");
      if (lineEnd < 0) break;
      const sizeToken = buffer.subarray(0, lineEnd).toString("latin1").split(";")[0].trim();
      if (!/^[0-9a-fA-F]+$/.test(sizeToken)) {
        throw new Error("antigravity wire: invalid chunk size");
      }
      const size = parseInt(sizeToken, 16);
      buffer = buffer.subarray(lineEnd + 2);
      if (size === 0) { buffer = Buffer.alloc(0); remaining = -1; return { chunks: out, done: true }; }
      remaining = size;
    }
    return { chunks: out, done: false };
  };
}

function decompress(headers, stream) {
  const encoding = String(headers["content-encoding"] || "").toLowerCase().trim();
  let decoder = null;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = zlib.createGunzip();
  else if (encoding === "deflate") decoder = zlib.createInflate();
  else if (encoding === "br") decoder = zlib.createBrotliDecompress();
  if (!decoder) return stream;
  delete headers["content-encoding"];
  delete headers["content-length"];
  stream.on("error", (err) => decoder.destroy(err));
  decoder.on("error", (err) => stream.destroy(err));
  decoder.on("close", () => { if (!stream.destroyed) stream.destroy(); });
  return stream.pipe(decoder);
}

/**
 * Send one request and return a web `Response`.
 * The caller owns the body; the socket is parked for reuse once it drains.
 */
export async function sendWireRequest(url, { method = "POST", headers, body, origin, proxyUrl = null, signal, tls: tlsOptions, alpnProtocol, allowReuse = true } = {}) {
  assertSafeToken(url, "url");
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = Number(parsed.port || 443);
  const upperMethod = assertValidHttpMethod(method);
  const requestPath = assertSafeToken(`${parsed.pathname}${parsed.search}`, "request path");
  if (/\s/.test(requestPath)) throw new Error("antigravity wire: invalid request path");
  const safeHeaders = (headers || []).map(([name, value]) => [
    assertValidHeaderName(name),
    assertSafeToken(value, `header ${name}`),
  ]);
  const resolvedOrigin = origin || parsed.origin;
  const resolvedProxy = proxyUrl || null;
  const poolKey = `${resolvedOrigin}::${proxyPoolKey(resolvedProxy)}`;
  const resolvedTls = alpnProtocol || tlsOptions?.alpnProtocol
    ? { ...(tlsOptions || {}), alpnProtocol: alpnProtocol || tlsOptions?.alpnProtocol }
    : tlsOptions;

  let socket = allowReuse ? takeIdleSocket(poolKey) : null;
  const reused = !!socket;
  if (!socket) socket = await connect(host, port, resolvedTls, resolvedProxy, signal);

  const requestHead = [`${upperMethod} ${requestPath} HTTP/1.1`, ...safeHeaders.map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
  const bodyBuf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payload = bodyBuf ? Buffer.concat([Buffer.from(requestHead, "latin1"), bodyBuf]) : Buffer.from(requestHead, "latin1");
  const onAbort = () => socket.destroy(abortError());
  if (signal) {
    if (signal.aborted) {
      if (reused) parkIdleSocket(poolKey, socket); else socket.destroy();
      throw abortError();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const bufferRef = { data: Buffer.alloc(0) };
  let head;
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { socket.off("error", onError); reject(error); };
      socket.once("error", onError);
      socket.write(payload, () => { socket.off("error", onError); resolve(); });
    });
    head = await readHead(socket, bufferRef);
  } catch (error) {
    socket.destroy();
    if (reused && !signal?.aborted && !error?.receivedAny) {
      dbg("AG_WIRE", `stale socket, retrying: ${error.message}`);
      return sendWireRequest(url, { method: upperMethod, headers: safeHeaders, body, origin: resolvedOrigin, proxyUrl: resolvedProxy, signal, tls: resolvedTls, alpnProtocol, allowReuse: false });
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  const { status, headers: resHeaders } = head;
  const noBody = upperMethod === "HEAD" || status === 204 || status === 205 || status === 304;
  const chunked = /chunked/i.test(resHeaders["transfer-encoding"] || "");
  const hasLength = resHeaders["content-length"] !== undefined;
  const length = hasLength ? Number(resHeaders["content-length"]) : NaN;
  if (!noBody && !chunked && hasLength && (!Number.isInteger(length) || length < 0)) {
    socket.destroy();
    throw new Error("antigravity wire: invalid Content-Length");
  }
  const keepAlive = !/close/i.test(resHeaders.connection || "") && !chunked && hasLength && Number.isInteger(length);

  const buildOutHeaders = () => {
    const out = new Headers();
    for (const [name, value] of Object.entries(resHeaders)) {
      if (name === "connection" || name === "transfer-encoding") continue;
      // Transport markers are ours alone. An upstream that sends them must not
      // be able to claim it was relayed by the Go backend or went via a proxy.
      if (name === "x-agwire-backend" || name === "x-9r-proxy-via") continue;
      out.set(name, value);
    }
    if (resolvedProxy) out.set("x-9r-proxy-via", safeProxyLabel(resolvedProxy));
    return out;
  };

  if (noBody) {
    if (!/close/i.test(resHeaders.connection || "")) parkIdleSocket(poolKey, socket);
    else socket.destroy();
    return new Response(null, { status, headers: buildOutHeaders() });
  }

  const sink = new PassThrough();
  const decoded = decompress(resHeaders, sink);
  const webBody = Readable.toWeb(decoded);
  const response = new Response(webBody, { status, headers: buildOutHeaders() });

  if (hasLength && length === 0) {
    sink.end();
    if (keepAlive && bufferRef.data.length === 0) parkIdleSocket(poolKey, socket); else socket.destroy();
    return response;
  }

  let bodyDone = false;
  let drainArmed = false;
  const onDrain = () => {
    drainArmed = false;
    socket.resume();
  };
  const writeChunk = (chunk) => {
    if (bodyDone || sink.destroyed) return;
    if (!sink.write(chunk) && !drainArmed) {
      drainArmed = true;
      socket.pause();
      sink.once("drain", onDrain);
    }
  };
  const onStreamAbort = () => {
    const err = abortError();
    sink.destroy(err);
    socket.destroy(err);
  };
  if (signal) signal.addEventListener("abort", onStreamAbort, { once: true });
  const cleanupStream = () => {
    if (signal) signal.removeEventListener("abort", onStreamAbort);
    sink.off("drain", onDrain);
    if (drainArmed) {
      drainArmed = false;
      if (!socket.destroyed) socket.resume();
    }
  };
  sink.once("close", () => {
    cleanupStream();
    // A normal end also emits "close"; only an abandoned body may kill the socket.
    if (bodyDone) return;
    bodyDone = true;
    if (!socket.destroyed) socket.destroy();
  });

  const chunks = bufferRef.data;
  if (!hasLength && !chunked) {
    const onData = (chunk) => writeChunk(chunk);
    const onEnd = () => { if (bodyDone) return; bodyDone = true; cleanupStream(); sink.end(); socket.destroy(); };
    const onError = (error) => { if (bodyDone) return; bodyDone = true; cleanupStream(); sink.destroy(error); socket.destroy(); };
    if (chunks.length) onData(chunks);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    return response;
  }

  if (chunked) {
    const decode = createChunkDecoder();
    const onEnd = () => {
      if (bodyDone) return;
      bodyDone = true;
      cleanupStream();
      sink.destroy(new Error("socket closed before chunked body completed"));
      socket.destroy();
    };
    const onError = (error) => {
      if (bodyDone) return;
      bodyDone = true;
      cleanupStream();
      sink.destroy(error);
      socket.destroy();
    };
    const feed = (chunk) => {
      if (bodyDone) return;
      let decodedChunk;
      try {
        decodedChunk = decode(chunk);
      } catch (err) {
        bodyDone = true;
        socket.off("data", feed);
        socket.off("end", onEnd);
        socket.off("error", onError);
        cleanupStream();
        sink.destroy(err);
        socket.destroy();
        return;
      }
      for (const c of decodedChunk.chunks) writeChunk(c);
      if (decodedChunk.done) {
        bodyDone = true;
        socket.off("data", feed);
        socket.off("end", onEnd);
        socket.off("error", onError);
        cleanupStream();
        sink.end();
        socket.destroy();
      }
    };
    if (chunks.length) feed(chunks);
    if (!bodyDone) {
      socket.on("data", feed);
      socket.once("end", onEnd);
      socket.once("error", onError);
    }
    return response;
  }

  let remaining = length;
  const onError = (error) => {
    if (bodyDone) return;
    bodyDone = true;
    cleanupStream();
    sink.destroy(error);
    socket.destroy();
  };
  const onEnd = () => {
    if (bodyDone) return;
    bodyDone = true;
    cleanupStream();
    if (remaining > 0) sink.destroy(new Error("socket closed before body completed"));
    socket.destroy();
  };
  const flush = (chunk) => {
    if (remaining <= 0 || bodyDone || sink.destroyed) return;
    const extraBytes = chunk.length > remaining;
    const slice = extraBytes ? chunk.subarray(0, remaining) : chunk;
    remaining -= slice.length;
    writeChunk(slice);
    if (remaining === 0) {
      bodyDone = true;
      socket.off("data", flush);
      socket.off("end", onEnd);
      socket.off("error", onError);
      cleanupStream();
      sink.end();
      // Socket is already drained of the HTTP response; park immediately so an
      // unread Response body cannot leak an open TLS socket.
      if (keepAlive && !extraBytes) parkIdleSocket(poolKey, socket);
      else socket.destroy();
    }
  };
  socket.once("error", onError);
  if (chunks.length) flush(chunks);
  if (remaining > 0) {
    socket.on("data", flush);
    socket.once("end", onEnd);
  }
  return response;
}

// ─── Go wire sidecar (`agwire`) ─────────────────────────────────────────────
// Go's crypto/tls reproduces `agy`'s ClientHello byte-for-byte (extension
// order, GREASE, key shares). Node's TLS sender below is the fallback; undici
// is never one.

const goSidecar = { proc: null, port: 0, token: null, bin: null, starting: null, generation: 0 };

function isExecutableFile(file) {
  if (!file) return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findAgwireBin(envBin) {
  if (envBin) return isExecutableFile(envBin) ? path.resolve(envBin) : null;
  const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
  const roots = [path.join(MODULE_DIR, "..", ".."), process.cwd(), path.join(process.cwd(), "app"), entryDir].filter(Boolean);
  const candidates = roots.map((root) => path.join(root, "bin", AGWIRE_BIN_NAME));
  for (const root of roots) candidates.push(path.join(root, "go", "bin", AGWIRE_BIN_NAME));
  const found = candidates.find(isExecutableFile);
  return found ? path.resolve(found) : null;
}

/** Resolved `agwire` path, or null when the sidecar is disabled or absent. */
function resolveAgwireBin() {
  const envBin = process.env.AGWIRE_BIN;
  if (envBin === "0") return null;
  return findAgwireBin(envBin);
}

/** Sync, never throws. `active` = the sidecar process is currently serving. */
export function getWireBackendInfo() {
  let binaryPath = null;
  try { binaryPath = resolveAgwireBin(); } catch { /* treat as absent */ }
  const proc = goSidecar.proc;
  const active = !!(
    binaryPath
    && proc
    && !proc.killed
    && proc.exitCode === null
    && proc.signalCode === null
    && goSidecar.port > 0
    && goSidecar.bin === binaryPath
  );
  return {
    backend: binaryPath ? "go-crypto-tls" : "node-openssl",
    binaryPath,
    active,
  };
}

function clearGoSidecar(proc) {
  if (proc && goSidecar.proc !== proc) return;
  goSidecar.proc = null;
  goSidecar.port = 0;
  goSidecar.token = null;
  goSidecar.bin = null;
  goSidecar.starting = null;
}

function teardownGoSidecar(expectedGen = null) {
  if (expectedGen !== null && goSidecar.generation !== expectedGen) return;
  goSidecar.generation += 1;
  const proc = goSidecar.proc;
  clearGoSidecar(proc);
  if (!proc) return;
  try { proc.stdin?.end(); } catch { /* ignore */ }
  try { if (!proc.killed && proc.exitCode === null) proc.kill(); } catch { /* ignore */ }
}

function sidecarIpcError(message) {
  const err = new Error(message);
  err.isSidecarIpcError = true;
  return err;
}

/** Lazy singleton: one Go process per engine, token rotated per instance. */
function ensureGoSidecar() {
  const bin = resolveAgwireBin();
  if (!bin) return Promise.reject(sidecarIpcError("agwire binary not found"));

  const proc = goSidecar.proc;
  if (proc && !proc.killed && proc.exitCode === null && proc.signalCode === null && goSidecar.port > 0 && goSidecar.bin === bin) {
    return Promise.resolve({ port: goSidecar.port, token: goSidecar.token, generation: goSidecar.generation });
  }
  if (proc && goSidecar.bin !== bin) {
    teardownGoSidecar();
  }
  if (goSidecar.starting) return goSidecar.starting;

  const gen = goSidecar.generation;
  const token = crypto.randomBytes(32).toString("hex");
  const startPromise = new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(bin, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGWIRE_TOKEN: token },
        windowsHide: true,
      });
    } catch (error) {
      reject(sidecarIpcError(error.message));
      return;
    }
    child.stdin?.on("error", () => {});
    goSidecar.proc = child;
    goSidecar.bin = bin;
    let stdout = "";
    const timer = setTimeout(() => fail(sidecarIpcError("agwire startup timeout")), SIDECAR_START_TIMEOUT_MS);
    timer.unref?.();
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      clearGoSidecar(child);
      try { child.stdin?.end(); } catch { /* ignore */ }
      try { if (!child.killed && child.exitCode === null) child.kill(); } catch { /* ignore */ }
      reject(error);
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_SIDECAR_STARTUP_BYTES) {
        fail(sidecarIpcError("agwire startup output exceeded limit"));
        return;
      }
      const nl = stdout.indexOf("\n");
      if (nl < 0 || settled) return;
      let port = 0;
      try { port = Number(JSON.parse(stdout.slice(0, nl)).port) || 0; } catch { /* malformed line */ }
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        fail(sidecarIpcError("agwire sent an invalid port line"));
        return;
      }
      if (goSidecar.generation !== gen) {
        fail(sidecarIpcError("agwire startup cancelled"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stdout.resume();
      goSidecar.port = port;
      goSidecar.token = token;
      // Detach so a long-lived dashboard never depends on the helper, but keep
      // stdin open: EOF there is the sidecar's "parent is gone, exit" signal.
      child.stdin?.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      child.unref?.();
      resolve({ port, token, generation: gen });
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk) => dbg("AG_WIRE", `agwire: ${chunk.toString("utf8").trim()}`));
    child.once("error", (err) => fail(sidecarIpcError(err.message)));
    child.once("exit", (code, sig) => {
      clearGoSidecar(child);
      fail(sidecarIpcError(`agwire exited before ready (code=${code ?? "null"} signal=${sig ?? "none"})`));
    });
  }).finally(() => {
    if (goSidecar.starting === startPromise) goSidecar.starting = null;
  });

  goSidecar.starting = startPromise;
  return startPromise;
}

function canUseGoWireForTls(tlsOptions) {
  if (!tlsOptions) return true;
  for (const key of Object.keys(tlsOptions)) {
    if (key === "connectHost" || key === "rejectUnauthorized") continue;
    if (tlsOptions[key] !== undefined) return false;
  }
  if ((tlsOptions.connectHost || tlsOptions.rejectUnauthorized === false) && process.env.AGWIRE_ALLOW_TEST_HOSTS !== "1") {
    return false;
  }
  return true;
}

/**
 * POST one request to the sidecar's loopback `/wire` endpoint. Uses `node:http`
 * so the sidecar hop never touches undici, and streams the response straight
 * into a web `Response` (SSE included).
 */
async function sendViaGoWire(url, { method, headers, body, proxyUrl, signal, tls: tlsOptions, alpnProtocol, allowReuse = true } = {}) {
  assertSafeToken(url, "url");
  const upperMethod = assertValidHttpMethod(method);
  const safeHeaders = (headers || []).map(([name, value]) => [
    assertValidHeaderName(name),
    assertSafeToken(value, `header ${name}`),
  ]);
  if (proxyUrl) validateProxyUrl(proxyUrl);

  if (signal?.aborted) throw abortError();
  const { port, token, generation } = await ensureGoSidecar();
  if (signal?.aborted) throw abortError();
  const allowTestHosts = process.env.AGWIRE_ALLOW_TEST_HOSTS === "1";
  const meta = {
    url: String(url),
    method: upperMethod,
    headers: safeHeaders,
    proxyUrl: proxyUrl ? String(proxyUrl) : "",
    alpn: alpnProtocolsFor(alpnProtocol ?? tlsOptions?.alpnProtocol),
    allowReuse: allowReuse !== false,
    insecureTls: allowTestHosts && tlsOptions?.rejectUnauthorized === false,
    connectHost: allowTestHosts ? String(tlsOptions?.connectHost || "") : "",
  };
  const metaHeader = JSON.stringify(meta).replace(/[\u007f-\uffff]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/wire",
      method: "POST",
      agent: false,
      headers: {
        "X-Agwire-Token": token,
        "X-Agwire-Meta": metaHeader,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload ? payload.length : 0),
      },
    });
    const onAbort = () => fail(abortError());
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      req.destroy();
      reject(error);
    };
    if (signal) {
      if (signal.aborted) { fail(abortError()); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.once("error", (err) => {
      if (!signal?.aborted) {
        // Only a pre-connect failure proves the sidecar never saw the request. A
        // reset after acceptance may already have reached upstream, and replaying
        // a non-idempotent POST would duplicate the turn.
        err.isSidecarIpcError = CONNECT_ERROR_CODES.has(err?.code) || IDEMPOTENT_METHODS.has(upperMethod);
        err.sidecarGeneration = generation;
      }
      fail(err);
    });
    req.once("response", (res) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);

      // No backend marker = pre-upstream sidecar error (400 validation/SSRF,
      // 403/405 IPC mismatch, or 502 upstream/proxy transport failure).
      if (!res.headers["x-agwire-backend"] && res.statusCode >= 400) {
        let text = "";
        let done = false;
        const isIpcStatus = res.statusCode === 403 || res.statusCode === 405;
        res.setEncoding("utf8");
        res.on("data", (chunk) => { if (text.length < 4096) text += chunk; });
        res.once("end", () => {
          if (done) return;
          done = true;
          let msg = `HTTP ${res.statusCode}`;
          try {
            const parsed = JSON.parse(text);
            if (parsed?.error) msg = parsed.error;
          } catch {
            if (text.trim()) msg = text.trim().slice(0, 200);
          }
          const err = new Error(`agwire error (${res.statusCode}): ${msg}`);
          err.isSidecarIpcError = isIpcStatus;
          err.sidecarGeneration = generation;
          reject(err);
        });
        res.once("error", (err) => {
          if (done) return;
          done = true;
          err.isSidecarIpcError = isIpcStatus;
          err.sidecarGeneration = generation;
          reject(err);
        });
        res.once("close", () => {
          if (done) return;
          done = true;
          const err = new Error(`agwire closed error response (${res.statusCode})`);
          err.isSidecarIpcError = isIpcStatus;
          err.sidecarGeneration = generation;
          reject(err);
        });
        return;
      }

      const out = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined || name === "connection" || name === "transfer-encoding") continue;
        if (Array.isArray(value)) for (const item of value) out.append(name, item);
        else out.set(name, value);
      }
      const noBody = upperMethod === "HEAD" || res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
      if (noBody) {
        res.resume();
        resolve(new Response(null, { status: res.statusCode, headers: out }));
        return;
      }
      let bodyStream = res;
      if (String(res.headers["content-encoding"] || "").toLowerCase().trim() === "br" && res.headers["content-length"] !== "0") {
        const brotli = zlib.createBrotliDecompress();
        res.on("error", (err) => brotli.destroy(err));
        brotli.on("error", (err) => res.destroy(err));
        brotli.on("close", () => { if (!res.destroyed) res.destroy(); });
        bodyStream = res.pipe(brotli);
        out.delete("content-encoding");
        out.delete("content-length");
      }
      const onStreamAbort = () => {
        const err = abortError();
        res.destroy(err);
        if (bodyStream !== res) bodyStream.destroy(err);
      };
      if (signal) signal.addEventListener("abort", onStreamAbort, { once: true });
      bodyStream.once("close", () => { if (signal) signal.removeEventListener("abort", onStreamAbort); });
      resolve(new Response(Readable.toWeb(bodyStream), { status: res.statusCode, headers: out }));
    });

    if (payload && payload.length) req.end(payload);
    else req.end();
  });
}

/**
 * Native wire sender for Antigravity. Go sidecar first (byte-exact ClientHello),
 * then Node's own TLS. There is no undici fallback: a wire failure is an error.
 */
async function antigravityDirectFetch(url, options = {}, proxyUrl = null) {
  const target = typeof url === "string" ? url : url.toString();
  assertSafeToken(target, "url");
  const parsed = new URL(target);
  const method = assertValidHttpMethod(options.method || "POST");
  const resolvedProxy = proxyUrl || options.proxyUrl || null;
  const token = extractToken(options.headers);
  const fp = getFingerprint({ probe: false });
  const alpnProtocol = options.alpnProtocol
    || (parsed.pathname.includes("streamGenerateContent") && fp.capturedFrom?.endpoints?.streamGenerateContent?.alpnProtocol)
    || fp.alpnProtocol
    || fp.capturedFrom?.alpnProtocol
    || "http/1.1";
  const body = toBodyBuffer(options.body);

  const headers = buildAntigravityHeaders({
    url: target,
    method,
    token,
    bodyLength: body ? body.length : 0,
    fp,
  });

  const wireOptions = {
    method,
    headers,
    body,
    origin: parsed.origin,
    proxyUrl: resolvedProxy,
    signal: options.signal,
    tls: options.tls,
    alpnProtocol,
    allowReuse: options.allowReuse !== false,
  };

  if (resolveAgwireBin() && canUseGoWireForTls(options.tls)) {
    try {
      return await sendViaGoWire(target, wireOptions);
    } catch (error) {
      if (!error?.isSidecarIpcError || options.signal?.aborted) {
        if (error?.code === "ECONNRESET" || error?.code === "EPIPE") {
          teardownGoSidecar(error.sidecarGeneration ?? null);
        }
        throw error;
      }
      teardownGoSidecar(error.sidecarGeneration ?? null);
      dbg("AG_WIRE", `agwire IPC failed (${error.message}), using node TLS wire`);
    }
  }
  return await sendWireRequest(target, wireOptions);
}
antigravityDirectFetch.proxyCapable = true;

/**
 * Drop-in replacement for `proxyAwareFetch` on Antigravity hosts.
 * Routes through `proxyAwareFetch` with `directFetch` (`proxyCapable = true`)
 * so proxy pools, strictProxy, and test mocks of `proxyAwareFetch` all work
 * uniformly while both direct and proxied traffic use the exact 6-header wire.
 */
export async function antigravityFetch(url, options = {}, proxyOptions = null) {
  const target = typeof url === "string" ? url : url.toString();
  let parsed;
  try { parsed = new URL(target); } catch { return proxyAwareFetch(url, options, proxyOptions); }
  if (!isAntigravityHost(parsed.hostname)) return proxyAwareFetch(url, options, proxyOptions);

  startFingerprintSync();

  // TLS overrides exist for tests that terminate the handshake on loopback.
  // Accepting them in production would let a caller redirect the connection or
  // disable verification on a request that is supposed to look native.
  const { tls: rawTls, ...rest } = options;
  const tlsAllowed = process.env.AGWIRE_ALLOW_TEST_HOSTS === "1";

  const fp = getFingerprint({ probe: false });
  const method = (options.method || "POST").toUpperCase();
  const token = extractToken(options.headers);
  const bodyLen = bodyByteLength(options.body);

  const headers = buildAntigravityHeaderObject({
    url: target,
    method,
    token,
    bodyLength: bodyLen,
    fp,
  });

  const allowReuse = !(proxyOptions?.forceFreshSocket === true || options?.forceFreshSocket === true);
  return proxyAwareFetch(target, {
    ...rest,
    method,
    headers,
    allowReuse,
    strictTls: true,
    alpnProtocol: (parsed.pathname.includes("streamGenerateContent") && fp.capturedFrom?.endpoints?.streamGenerateContent?.alpnProtocol)
      || fp.alpnProtocol
      || fp.capturedFrom?.alpnProtocol
      || "http/1.1",
    ...(tlsAllowed && rawTls ? { tls: rawTls } : {}),
    directFetch: antigravityDirectFetch,
  }, proxyOptions);
}

function toBodyBuffer(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
}

function bodyByteLength(body) {
  if (body == null) return 0;
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return body.byteLength;
  return Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body));
}

function extractToken(headers) {
  if (!headers) return null;
  const get = (name) => {
    if (typeof headers.get === "function") return headers.get(name);
    if (Array.isArray(headers)) {
      const pair = headers.find((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === name);
      return pair ? pair[1] : null;
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return headers[key];
    }
    return null;
  };
  const raw = get("authorization") || get("Authorization");
  if (!raw) return null;
  return String(raw).replace(/^Bearer\s+/i, "");
}

/** Small JSON helper for metadata calls (lifecycle, quota). */
export async function antigravityPostJson(url, { token, body, timeoutMs = 10_000, proxyOptions = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await antigravityFetch(url, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    }, proxyOptions);
    let json = null;
    let text = "";
    if (!(response instanceof Response) && typeof response.json === "function") {
      json = await response.json().catch(() => null);
    } else if (typeof response.text === "function") {
      text = await response.text().catch(() => "");
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    } else if (typeof response.json === "function") {
      json = await response.json().catch(() => null);
    }
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    return { ok: false, status: 0, json: null, text: "", error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

export function resetAntigravityWire() {
  teardownGoSidecar();
  for (const pool of idleSockets.values()) {
    for (const socket of pool) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
  }
  idleSockets.clear();
  dnsCache.clear();
}
