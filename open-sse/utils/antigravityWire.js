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
 * Everything else (proxy pools, TLS fallbacks, stale-socket replay) stays in
 * `proxyFetch.js`: a configured proxy takes that path unchanged.
 */

import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { PassThrough, Readable } from "node:stream";
import { getFingerprint, buildUserAgent, startFingerprintSync } from "../services/antigravityFingerprint.js";
import { proxyAwareFetch } from "./proxyFetch.js";
import { dbg } from "./debugLog.js";

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
const ECDH_CURVE = process.env.NINEROUTER_TLS_ECDH_CURVE || "X25519";

/** origin -> idle sockets[]. */
const idleSockets = new Map();
const dnsCache = new Map();

export function isAntigravityHost(hostname) {
  return ANTIGRAVITY_HOSTS.has(String(hostname || "").toLowerCase());
}

function canonicalHeaderName(name) {
  const lower = String(name || "").toLowerCase();
  return CANONICAL_HEADER_NAMES[lower] || name;
}

/**
 * Ordered header list from the fingerprint snapshot. Values we cannot know are
 * omitted rather than invented; unknown snapshot headers are skipped so a
 * capture from a newer binary never ships a malformed request.
 */
export function buildAntigravityHeaders({ url, method = "POST", token, bodyLength, fp = getFingerprint({ probe: false }) }) {
  const parsed = new URL(url);
  const upperMethod = String(method || "POST").toUpperCase();
  const hasBody = (bodyLength ?? 0) > 0 || (upperMethod !== "GET" && upperMethod !== "HEAD");
  const values = {
    host: parsed.host,
    "user-agent": buildUserAgent(fp),
    "content-length": hasBody ? String(bodyLength ?? 0) : undefined,
    authorization: token ? `Bearer ${token}` : undefined,
    "content-type": hasBody ? "application/json" : undefined,
    "accept-encoding": "gzip",
  };
  const out = [];
  for (const name of fp.headers) {
    const lower = String(name).toLowerCase();
    const value = values[lower];
    if (value === undefined) continue;
    out.push([canonicalHeaderName(lower), value]);
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
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const sys = await dns.promises.lookup(hostname, { family: 4 });
    if (sys?.address && !isLoopbackIp(sys.address)) {
      dnsCache.set(hostname, { ip: sys.address, expiry: Date.now() + DNS_CACHE_TTL_MS });
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
      dnsCache.set(hostname, { ip: addrs[0], expiry: Date.now() + DNS_CACHE_TTL_MS });
      return addrs[0];
    }
  } catch { /* fall back to hostname */ }

  return hostname;
}

async function connect(host, port, tlsOptions = null) {
  const connectHost = tlsOptions?.connectHost || await resolveConnectHost(host);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: connectHost,
      port,
      servername: host,
      ALPNProtocols: ["http/1.1"],
      ecdhCurve: ECDH_CURVE,
      ...(tlsOptions || {}),
    });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("antigravity wire connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
    const onError = (error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
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
      if (idx < 0) return;
      cleanup();
      const head = bufferRef.data.subarray(0, idx).toString("latin1");
      bufferRef.data = bufferRef.data.subarray(idx + 4);
      const [statusLine, ...headerLines] = head.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const headers = {};
      for (const line of headerLines) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status, headers, statusLine });
    };
    const onEnd = () => { cleanup(); reject(new Error("socket closed before response headers")); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    if (bufferRef.data.indexOf("\r\n\r\n") >= 0) onData(Buffer.alloc(0));
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
      const size = parseInt(buffer.subarray(0, lineEnd).toString("latin1").split(";")[0], 16);
      buffer = buffer.subarray(lineEnd + 2);
      if (!Number.isFinite(size)) { buffer = Buffer.alloc(0); break; }
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
  return stream.pipe(decoder);
}

/**
 * Send one request and return a web `Response`.
 * The caller owns the body; the socket is parked for reuse once it drains.
 */
export async function sendWireRequest(url, { method = "POST", headers, body, origin, signal, tls: tlsOptions, allowReuse = true } = {}) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || 443);
  const requestPath = `${parsed.pathname}${parsed.search}`;
  const resolvedOrigin = origin || parsed.origin;

  let socket = allowReuse ? takeIdleSocket(resolvedOrigin) : null;
  const reused = !!socket;
  if (!socket) socket = await connect(host, port, tlsOptions);

  const requestHead = [`${method} ${requestPath} HTTP/1.1`, ...headers.map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
  const payload = body ? Buffer.concat([Buffer.from(requestHead, "latin1"), body]) : Buffer.from(requestHead, "latin1");

  const onAbort = () => socket.destroy(new Error("aborted"));
  if (signal) {
    if (signal.aborted) {
      if (reused) parkIdleSocket(resolvedOrigin, socket); else socket.destroy();
      throw new Error("aborted");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const parked = new WeakSet();
  let unconsumed = false;
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
    if (reused && !signal?.aborted) {
      dbg("AG_WIRE", `stale socket, retrying: ${error.message}`);
      return sendWireRequest(url, { method, headers, body, origin: resolvedOrigin, signal, tls: tlsOptions, allowReuse: false });
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  const { status, headers: resHeaders } = head;
  const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
  const chunked = /chunked/i.test(resHeaders["transfer-encoding"] || "");
  const hasLength = resHeaders["content-length"] !== undefined;
  const length = hasLength ? Number(resHeaders["content-length"]) : NaN;
  const keepAlive = !/close/i.test(resHeaders.connection || "") && !chunked && hasLength && Number.isFinite(length);

  const buildOutHeaders = () => {
    const out = new Headers();
    for (const [name, value] of Object.entries(resHeaders)) {
      if (name === "connection" || name === "transfer-encoding") continue;
      out.set(name, value);
    }
    return out;
  };

  if (noBody) {
    if (!/close/i.test(resHeaders.connection || "")) parkIdleSocket(resolvedOrigin, socket);
    else socket.destroy();
    return new Response(null, { status, headers: buildOutHeaders() });
  }

  const sink = new PassThrough();
  const decoded = decompress(resHeaders, sink);
  const webBody = Readable.toWeb(decoded);
  const response = new Response(webBody, { status, headers: buildOutHeaders() });

  queueMicrotask(() => {
    if (sink.readableLength === 0 && !sink.readableEnded && !sink.destroyed) unconsumed = true;
  });

  if (hasLength && length === 0) {
    sink.end();
    if (keepAlive) parkIdleSocket(resolvedOrigin, socket); else socket.destroy();
    return response;
  }

  const chunks = bufferRef.data;
  if (!hasLength && !chunked) {
    if (chunks.length) sink.write(chunks);
    socket.on("data", (chunk) => sink.write(chunk));
    socket.once("end", () => { sink.end(); socket.destroy(); });
    socket.once("error", (error) => { sink.destroy(error); socket.destroy(); });
    return response;
  }

  if (chunked) {
    const decode = createChunkDecoder();
    let finished = false;
    const feed = (chunk) => {
      if (finished) return;
      const { chunks: out, done } = decode(chunk);
      for (const c of out) sink.write(c);
      if (done) {
        finished = true;
        socket.off("data", feed);
        sink.end();
        socket.destroy();
      }
    };
    if (chunks.length) feed(chunks);
    if (!finished) {
      socket.on("data", feed);
      socket.once("end", () => { if (!finished) sink.end(); });
      socket.once("error", (error) => { sink.destroy(error); socket.destroy(); });
    }
    return response;
  }

  let remaining = length;
  const onError = (error) => { sink.destroy(error); socket.destroy(); };
  const onEnd = () => {
    if (remaining > 0) sink.destroy(new Error("socket closed before body completed"));
  };
  const flush = (chunk) => {
    if (remaining <= 0) return;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    remaining -= slice.length;
    sink.write(slice);
    if (remaining === 0) {
      socket.off("data", flush);
      socket.off("end", onEnd);
      socket.off("error", onError);
      sink.end();
      if (keepAlive) parked.add(socket);
    }
  };
  socket.once("error", onError);
  if (chunks.length) flush(chunks);
  if (remaining > 0) {
    socket.on("data", flush);
    socket.once("end", onEnd);
  }
  decoded.once("end", () => {
    if (parked.has(socket)) {
      if (unconsumed) socket.destroy();
      else parkIdleSocket(resolvedOrigin, socket);
    }
  });
  return response;
}


/**
 * Drop-in replacement for `proxyAwareFetch` on Antigravity hosts.
 * Any configured proxy keeps the existing proxy path; every failure falls back
 * to it so a wire regression can never take the provider down.
 */
async function antigravityDirectFetch(url, options = {}) {
  const target = typeof url === "string" ? url : url.toString();
  const parsed = new URL(target);
  const method = (options.method || "POST").toUpperCase();
  const token = extractToken(options.headers);
  const body = options.body == null
    ? null
    : Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(typeof options.body === "string" ? options.body : JSON.stringify(options.body));

  const headers = buildAntigravityHeaders({
    url: target,
    method,
    token,
    bodyLength: body ? body.length : 0,
  });

  try {
    return await sendWireRequest(target, {
      method,
      headers,
      body,
      origin: parsed.origin,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || process.env.ANTIGRAVITY_WIRE_DIRECT === "1") throw error;
    dbg("AG_WIRE", `direct send failed (${error.message}), falling back to proxyFetch`);
    return proxyAwareFetch(url, { ...options, directFetch: undefined }, null);
  }
}

/**
 * Drop-in replacement for `proxyAwareFetch` on Antigravity hosts.
 * Routes through `proxyAwareFetch` with `directFetch` so proxy pools, strictProxy,
 * and test mocks of `proxyAwareFetch` all work uniformly while direct traffic
 * uses the exact 6-header wire sender.
 */
export async function antigravityFetch(url, options = {}, proxyOptions = null) {
  const target = typeof url === "string" ? url : url.toString();
  let parsed;
  try { parsed = new URL(target); } catch { return proxyAwareFetch(url, options, proxyOptions); }
  if (!isAntigravityHost(parsed.hostname)) return proxyAwareFetch(url, options, proxyOptions);

  startFingerprintSync();

  const method = (options.method || "POST").toUpperCase();
  const token = extractToken(options.headers);
  const bodyLen = options.body == null
    ? 0
    : Buffer.isBuffer(options.body)
      ? options.body.length
      : Buffer.byteLength(typeof options.body === "string" ? options.body : JSON.stringify(options.body));

  const headers = buildAntigravityHeaderObject({
    url: target,
    method,
    token,
    bodyLength: bodyLen,
  });

  return proxyAwareFetch(target, {
    ...options,
    method,
    headers,
    directFetch: antigravityDirectFetch,
  }, proxyOptions);
}

function extractToken(headers) {
  if (!headers) return null;
  const get = (name) => {
    if (typeof headers.get === "function") return headers.get(name);
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
  for (const pool of idleSockets.values()) {
    for (const socket of pool) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
  }
  idleSockets.clear();
  dnsCache.clear();
}
