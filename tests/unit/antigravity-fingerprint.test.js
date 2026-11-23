import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import https from "node:https";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cert = require("../../src/mitm/cert/generate.js");

const {
  parseCapturedRequest,
  uaToTemplate,
  buildUserAgent,
  getFingerprint,
  readSnapshot,
  needsRefresh,
  captureFingerprint,
  updateBinary,
  refreshFingerprint,
  startFingerprintSync,
  resetFingerprintCaches,
} = await import("../../open-sse/services/antigravityFingerprint.js");

const {
  buildAntigravityHeaders,
  buildAntigravityHeaderObject,
  sendWireRequest,
  antigravityFetch,
  getWireBackendInfo,
  resetAntigravityWire,
} = await import("../../open-sse/utils/antigravityWire.js");

describe("antigravityFingerprint", () => {
  let tmpDir;
  const prevDataDir = process.env.DATA_DIR;
  const prevAgyBin = process.env.AGY_BIN;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-fp-test-"));
    process.env.DATA_DIR = tmpDir;
    process.env.AGY_BIN = path.join(tmpDir, "missing-agy");
    resetFingerprintCaches();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetFingerprintCaches();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses raw HTTP/1.1 request head preserving header order", () => {
    const raw = [
      "POST /v1internal:loadCodeAssist HTTP/1.1",
      "Host: daily-cloudcode-pa.googleapis.com",
      "User-Agent: antigravity/cli/1.5.14 (aidev_client; os_type=linux; arch=amd64; cl=1026970498; auth_method=consumer)",
      "Content-Length: 38",
      "Authorization: Bearer tok",
      "Content-Type: application/json",
      "Accept-Encoding: gzip",
      "",
      "",
    ].join("\r\n");

    const parsed = parseCapturedRequest(raw);
    expect(parsed.method).toBe("POST");
    expect(parsed.path).toBe("/v1internal:loadCodeAssist");
    expect(parsed.httpVersion).toBe("HTTP/1.1");
    expect(parsed.headers.map(([k]) => k)).toEqual([
      "host",
      "user-agent",
      "content-length",
      "authorization",
      "content-type",
      "accept-encoding",
    ]);
  });

  it("converts captured UA to template, strips ACP host_path, and omits empty cl=", () => {
    const acpUa = "antigravity/cli/1.5.14 (aidev_client; os_type=linux; arch=amd64; cl=1026970498; auth_method=consumer; host_path=fp-probe/1)";
    const tpl = uaToTemplate(acpUa, { cl: "1026970498", version: "1.5.14" });
    expect(tpl).toBe("antigravity/cli/{version} (aidev_client; os_type={os}; arch={arch}; cl={cl}; auth_method=consumer)");

    const built = buildUserAgent({ version: "1.5.15", cl: "9999999999", uaTemplate: tpl });
    expect(built).toContain("antigravity/cli/1.5.15");
    expect(built).toContain("cl=9999999999");

    const noCl = buildUserAgent({ version: "1.5.15", cl: "", uaTemplate: tpl });
    expect(noCl).not.toContain("cl=");
    expect(noCl).not.toContain("; ;");
  });

  it("falls back to bundled snapshot and detects drift against live binary version", () => {
    const bundled = readSnapshot();
    expect(bundled).toBeTruthy();
    expect(bundled.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof bundled.cl).toBe("string");
    expect(bundled.cl.length).toBeGreaterThan(0);
    expect(bundled._origin).toBe("bundled");

    const fakeBin = path.join(tmpDir, "agy");
    fs.writeFileSync(fakeBin, "#!/bin/sh\necho 1.5.99\n", { mode: 0o755 });
    process.env.AGY_BIN = fakeBin;
    resetFingerprintCaches();

    const fp = getFingerprint();
    expect(fp.source).toBe("bundled");
    expect(fp.liveVersion).toBe("1.5.99");
    expect(fp.stale).toBe(true);
    expect(needsRefresh()).toBe(true);
  });

  it("prefers DATA_DIR snapshot over bundled fallback", () => {
    fs.writeFileSync(path.join(tmpDir, "agy-fingerprint.json"), JSON.stringify({
      version: "1.6.0",
      cl: "1099999999",
      uaTemplate: "antigravity/cli/{version} (aidev_client; os_type={os}; arch={arch}; cl={cl}; auth_method=consumer)",
      headers: ["host", "user-agent", "content-length", "authorization", "content-type", "accept-encoding"],
    }));

    const fp = getFingerprint();
    expect(fp.source).toBe("snapshot");
    expect(fp.version).toBe("1.6.0");
    expect(fp.cl).toBe("1099999999");
    expect(buildUserAgent(fp)).toContain("antigravity/cli/1.6.0");
  });

  it("captures live request shape from a mock binary behind the local CONNECT recorder", async () => {
    const fakeBin = path.join(tmpDir, "agy");
    fs.writeFileSync(fakeBin, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.5.77"); process.exit(0); }
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const proxy = new URL(process.env.HTTPS_PROXY);
const sock = net.connect(Number(proxy.port), proxy.hostname, () => {
  sock.write("CONNECT daily-cloudcode-pa.googleapis.com:443 HTTP/1.1\\r\\nHost: daily-cloudcode-pa.googleapis.com:443\\r\\n\\r\\n");
});
let buf = "";
sock.on("data", (d) => {
  buf += d.toString();
  if (!buf.includes("\\r\\n\\r\\n")) return;
  const ts = tls.connect({ socket: sock, servername: "daily-cloudcode-pa.googleapis.com", ca: fs.readFileSync(process.env.SSL_CERT_FILE) }, () => {
    const body = '{"metadata":{"ideType":"ANTIGRAVITY"}}';
    ts.write([
      "POST /v1internal:loadCodeAssist HTTP/1.1",
      "Host: daily-cloudcode-pa.googleapis.com",
      "User-Agent: antigravity/cli/1.5.77 (aidev_client; os_type=linux; arch=amd64; cl=1077777777; auth_method=consumer)",
      "Content-Length: " + body.length,
      "Authorization: Bearer dummy",
      "Content-Type: application/json",
      "Accept-Encoding: gzip",
      "",
      body,
    ].join("\\r\\n"));
  });
  ts.on("data", () => process.exit(0));
});
`, { mode: 0o755 });
    process.env.AGY_BIN = fakeBin;
    resetFingerprintCaches();

    const snap = await captureFingerprint({ timeoutMs: 10_000 });
    expect(snap).toBeTruthy();
    expect(snap.version).toBe("1.5.77");
    expect(snap.cl).toBe("1077777777");
    expect(snap.headers).toEqual([
      "host",
      "user-agent",
      "content-length",
      "authorization",
      "content-type",
      "accept-encoding",
    ]);
    expect(buildUserAgent(snap)).toContain("cl=1077777777");
  });

  it("updates an idle binary once per interval and honours the opt-out", async () => {
    const calls = path.join(tmpDir, "update-calls");
    const fakeBin = path.join(tmpDir, "agy");
    fs.writeFileSync(fakeBin, `#!/bin/sh
if [ "$1" = "update" ]; then echo run >> ${calls}; fi
echo 1.5.99
`, { mode: 0o755 });
    process.env.AGY_BIN = fakeBin;
    resetFingerprintCaches();

    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-23T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    const [first, concurrent] = await Promise.all([updateBinary(), updateBinary()]);
    expect(first).toBe(true);
    expect(concurrent).toBe(true);
    expect(await updateBinary()).toBe(false);

    // Still throttled inside the 25m guard, but ready by the 30m tick (even after the 5s startup offset).
    vi.setSystemTime(t0 + 24 * 60 * 1000);
    expect(await updateBinary()).toBe(false);
    vi.setSystemTime(t0 + 29 * 60 * 1000 + 55 * 1000);
    expect(await updateBinary()).toBe(true);

    expect(await updateBinary({ force: true })).toBe(true);
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(3);
    // A refresh must drop the cached `--version`, or the recapture never fires.
    expect(needsRefresh()).toBe(true);

    process.env.ANTIGRAVITY_AGY_UPDATE = "0";
    resetFingerprintCaches();
    expect(await updateBinary()).toBe(false);
    delete process.env.ANTIGRAVITY_AGY_UPDATE;
  });

  it("arms the background sync timer on a 30-minute interval and shares state across imports", () => {
    const prevCapture = process.env.ANTIGRAVITY_FINGERPRINT_CAPTURE;
    delete process.env.ANTIGRAVITY_FINGERPRINT_CAPTURE;
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      startFingerprintSync();
      startFingerprintSync();
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
    } finally {
      resetFingerprintCaches();
      if (prevCapture !== undefined) process.env.ANTIGRAVITY_FINGERPRINT_CAPTURE = prevCapture;
    }
  });

  it("updates lastCheckedAt on 30m checks even when the binary version did not change", async () => {
    const fakeBin = path.join(tmpDir, "agy");
    fs.writeFileSync(fakeBin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.5.15; exit 0; fi
exit 0
`, { mode: 0o755 });
    process.env.AGY_BIN = fakeBin;
    const snapFile = path.join(tmpDir, "agy-fingerprint.json");
    const oldCapturedAt = "2026-11-23T08:37:22.410Z";
    fs.writeFileSync(snapFile, JSON.stringify({
      version: "1.5.15",
      cl: "1027820220",
      alpnProtocol: "http/1.1",
      uaTemplate: "antigravity/cli/{version} (aidev_client; os_type={os}; arch={arch}; cl={cl}; auth_method=consumer)",
      headers: ["host", "user-agent", "content-length", "authorization", "content-type", "accept-encoding"],
      capturedAt: oldCapturedAt,
    }));
    resetFingerprintCaches();

    const fp = await refreshFingerprint();
    expect(fp.version).toBe("1.5.15");
    expect(fp.capturedAt).toBe(oldCapturedAt);
    expect(fp.lastCheckedAt).toBeTruthy();
    expect(fp.lastCheckedAt > oldCapturedAt).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(snapFile, "utf8"));
    expect(persisted.capturedAt).toBe(oldCapturedAt);
    expect(persisted.lastCheckedAt).toBe(fp.lastCheckedAt);
  });
});

/** Parse a TLS ClientHello: supported groups (10), key shares (51), ALPN (16). */
function parseClientHello(buf) {
  let p = 5 + 1 + 3 + 2 + 32;
  p += 1 + buf[p];
  p += 2 + buf.readUInt16BE(p);
  p += 1 + buf[p];
  const end = p + 2 + buf.readUInt16BE(p);
  p += 2;
  const groups = [];
  const keyShares = [];
  const alpn = [];
  while (p + 4 <= end) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    p += 4;
    const body = buf.subarray(p, p + len);
    p += len;
    if (type === 10) {
      const n = body.readUInt16BE(0);
      for (let i = 2; i + 2 <= 2 + n; i += 2) groups.push(body.readUInt16BE(i));
    } else if (type === 51) {
      const n = body.readUInt16BE(0);
      let q = 2;
      while (q + 4 <= 2 + n) {
        const group = body.readUInt16BE(q);
        q += 2;
        const shareLen = body.readUInt16BE(q);
        q += 2 + shareLen;
        keyShares.push(group);
      }
    } else if (type === 16) {
      const listLen = body.readUInt16BE(0);
      let q = 2;
      while (q < 2 + listLen) {
        const nameLen = body[q];
        q += 1;
        alpn.push(body.subarray(q, q + nameLen).toString("latin1"));
        q += nameLen;
      }
    }
  }
  return { groups, keyShares, alpn };
}

/** Raw TCP server that captures one ClientHello and drops the connection. */
async function startHelloServer() {
  let resolveHello;
  const hello = new Promise((resolve) => { resolveHello = resolve; });
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 5 || buf[0] !== 22) return;
      if (buf.length < 5 + buf.readUInt16BE(3)) return;
      resolveHello(parseClientHello(buf));
      socket.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, hello };
}

/** Minimal stand-in for `go/agwire`: same port line + `/wire` IPC contract. */
function writeFakeAgwire(dir) {
  const file = path.join(dir, "fake-agwire");
  fs.writeFileSync(file, `#!/usr/bin/env node
const http = require("node:http");
const token = process.env.AGWIRE_TOKEN;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.headers["x-agwire-token"] !== token) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad token" }));
      return;
    }
    const meta = JSON.parse(req.headers["x-agwire-meta"]);
    if (String(meta.url).includes("refuse")) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream boom" }));
      return;
    }
    const out = JSON.stringify({
      via: "go",
      url: meta.url,
      headers: meta.headers,
      alpn: meta.alpn,
      body: Buffer.concat(chunks).toString("utf8"),
      insecureTls: meta.insecureTls,
      connectHost: meta.connectHost,
      token: req.headers["x-agwire-token"],
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "x-agwire-backend": "go-crypto-tls",
      "content-length": Buffer.byteLength(out),
    });
    res.end(out);
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
  return file;
}

describe("antigravityWire", () => {
  let tmpDir;
  const prevEnv = {
    DATA_DIR: process.env.DATA_DIR,
    AGWIRE_BIN: process.env.AGWIRE_BIN,
    AGWIRE_ALLOW_TEST_HOSTS: process.env.AGWIRE_ALLOW_TEST_HOSTS,
    NO_PROXY: process.env.NO_PROXY,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-wire-test-"));
    process.env.DATA_DIR = tmpDir;
    process.env.AGWIRE_BIN = "0";
    process.env.NO_PROXY = "*";
    delete process.env.AGWIRE_ALLOW_TEST_HOSTS;
    resetFingerprintCaches();
    resetAntigravityWire();
  });

  afterEach(() => {
    resetAntigravityWire();
    resetFingerprintCaches();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds canonical Go header casing in exact snapshot order and omits body headers on GET", () => {
    const postHeaders = buildAntigravityHeaders({
      url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      method: "POST",
      token: "tok-1",
      bodyLength: 42,
    });
    expect(postHeaders.map(([k]) => k)).toEqual([
      "Host",
      "User-Agent",
      "Content-Length",
      "Authorization",
      "Content-Type",
      "Accept-Encoding",
    ]);
    expect(postHeaders[2]).toEqual(["Content-Length", "42"]);
    expect(postHeaders[3]).toEqual(["Authorization", "Bearer tok-1"]);

    const getHeaders = buildAntigravityHeaders({
      url: "https://aicode.googleapis.com/v1alpha:fetchConfig",
      method: "GET",
      token: "tok-1",
      bodyLength: 0,
    });
    expect(getHeaders.map(([k]) => k)).toEqual([
      "Host",
      "User-Agent",
      "Authorization",
      "Accept-Encoding",
    ]);

    const obj = buildAntigravityHeaderObject({
      url: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      token: "tok-1",
      bodyLength: 38,
    });
    expect(Object.keys(obj)).toEqual([
      "Host",
      "User-Agent",
      "Content-Length",
      "Authorization",
      "Content-Type",
      "Accept-Encoding",
    ]);
  });

  it("sends exact 6 headers over TLS with zero Connection/Accept/Sec-Fetch leaks and decodes gzip + chunked SSE", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    const seen = [];

    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      const pairs = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        pairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      }
      seen.push({ url: req.url, pairs });

      if (req.url.includes("gzip-json")) {
        const gz = zlib.gzipSync(Buffer.from('{"ok":true,"n":1}'));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": String(gz.length),
        });
        res.end(gz);
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Transfer-Encoding": "chunked",
      });
      res.write('data: {"chunk":1}\n\n');
      res.end('data: {"chunk":2}\n\n');
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const body1 = Buffer.from('{"metadata":{"ideType":"ANTIGRAVITY"}}');
      const url1 = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:gzip-json`;
      const res1 = await sendWireRequest(url1, {
        method: "POST",
        headers: buildAntigravityHeaders({ url: url1, token: "tok-wire", bodyLength: body1.length }),
        body: body1,
        origin: `https://127.0.0.1:${port}`,
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      });
      expect(res1.status).toBe(200);
      expect(await res1.json()).toEqual({ ok: true, n: 1 });

      expect(seen[0].pairs.map(([k]) => k)).toEqual([
        "Host",
        "User-Agent",
        "Content-Length",
        "Authorization",
        "Content-Type",
        "Accept-Encoding",
      ]);
      const lowerNames = seen[0].pairs.map(([k]) => k.toLowerCase());
      expect(lowerNames).not.toContain("connection");
      expect(lowerNames).not.toContain("transfer-encoding");
      expect(lowerNames).not.toContain("accept");
      expect(lowerNames).not.toContain("accept-language");
      expect(lowerNames).not.toContain("sec-fetch-mode");

      // Second request reuses the parked keep-alive socket and reads chunked SSE.
      const body2 = Buffer.from('{"request":{}}');
      const url2 = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:streamGenerateContent?alt=sse`;
      const res2 = await sendWireRequest(url2, {
        method: "POST",
        headers: buildAntigravityHeaders({ url: url2, token: "tok-wire", bodyLength: body2.length }),
        body: body2,
        origin: `https://127.0.0.1:${port}`,
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      });
      expect(res2.status).toBe(200);
      expect(await res2.text()).toBe('data: {"chunk":1}\n\ndata: {"chunk":2}\n\n');
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("tunnels exact 6 headers through HTTP CONNECT proxy with auth and isolates pools per proxy", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    const upstreamSeen = [];
    const upstream = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      const pairs = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) pairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      upstreamSeen.push(pairs);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "11" });
      res.end('{"via":"p"}');
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;

    const connectLog = [];
    const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    proxy.on("connect", (req, clientSocket, head) => {
      connectLog.push({
        url: req.url,
        auth: req.headers["proxy-authorization"] || null,
      });
      const [, portStr] = String(req.url).split(":");
      const target = net.connect(Number(portStr), "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) target.write(head);
        target.pipe(clientSocket);
        clientSocket.pipe(target);
      });
      target.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => target.destroy());
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = proxy.address().port;

    try {
      const url = `https://daily-cloudcode-pa.googleapis.com:${upstreamPort}/v1internal:loadCodeAssist`;
      const body = Buffer.from('{"metadata":{"ideType":"ANTIGRAVITY"}}');
      const proxyA = `http://alice:s3cr%40t@127.0.0.1:${proxyPort}`;
      const proxyB = `http://bob:other@127.0.0.1:${proxyPort}`;

      const resA1 = await sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok-a", bodyLength: body.length }),
        body,
        proxyUrl: proxyA,
        tls: { rejectUnauthorized: false },
      });
      expect(resA1.status).toBe(200);
      expect(await resA1.json()).toEqual({ via: "p" });
      expect(resA1.headers.get("x-9r-proxy-via")).toBe(`http://127.0.0.1:${proxyPort}`);

      // Second request on proxyA reuses the parked tunnel; proxyB must open a new tunnel.
      const resA2 = await sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok-a", bodyLength: body.length }),
        body,
        proxyUrl: proxyA,
        tls: { rejectUnauthorized: false },
      });
      expect(await resA2.json()).toEqual({ via: "p" });

      const resB = await sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok-b", bodyLength: body.length }),
        body,
        proxyUrl: proxyB,
        tls: { rejectUnauthorized: false },
      });
      expect(await resB.json()).toEqual({ via: "p" });

      expect(connectLog).toHaveLength(2);
      expect(connectLog[0]).toEqual({
        url: `daily-cloudcode-pa.googleapis.com:${upstreamPort}`,
        auth: `Basic ${Buffer.from("alice:s3cr@t").toString("base64")}`,
      });
      expect(connectLog[1]).toEqual({
        url: `daily-cloudcode-pa.googleapis.com:${upstreamPort}`,
        auth: `Basic ${Buffer.from("bob:other").toString("base64")}`,
      });

      for (const pairs of upstreamSeen) {
        expect(pairs.map(([k]) => k)).toEqual([
          "Host",
          "User-Agent",
          "Content-Length",
          "Authorization",
          "Content-Type",
          "Accept-Encoding",
        ]);
        const lower = pairs.map(([k]) => k.toLowerCase());
        expect(lower).not.toContain("proxy-authorization");
        expect(lower).not.toContain("connection");
      }
    } finally {
      resetAntigravityWire();
      proxy.close();
      upstream.close();
    }
  });

  it("tunnels exact 6 headers through SOCKS5 proxy with username/password auth", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    const upstreamSeen = [];
    const upstream = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      const pairs = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) pairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      upstreamSeen.push(pairs);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "14" });
      res.end('{"socks":true}');
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;

    let socksAuth = null;
    let socksTarget = null;
    const socksServer = net.createServer((client) => {
      let stage = "greeting";
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === "greeting") {
          if (buf.length < 2) return;
          const nMethods = buf[1];
          if (buf.length < 2 + nMethods) return;
          buf = buf.subarray(2 + nMethods);
          stage = "auth";
          client.write(Buffer.from([0x05, 0x02])); // username/password auth
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const uLen = buf[1];
          if (buf.length < 3 + uLen) return;
          const pLen = buf[2 + uLen];
          if (buf.length < 3 + uLen + pLen) return;
          const user = buf.subarray(2, 2 + uLen).toString("utf8");
          const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString("utf8");
          socksAuth = `${user}:${pass}`;
          buf = buf.subarray(3 + uLen + pLen);
          stage = "request";
          client.write(Buffer.from([0x01, 0x00])); // auth OK
        }
        if (stage === "request") {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host;
          let offset;
          if (atyp === 0x03) {
            const len = buf[4];
            if (buf.length < 5 + len + 2) return;
            host = buf.subarray(5, 5 + len).toString("utf8");
            offset = 5 + len;
          } else if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            offset = 8;
          } else {
            client.destroy();
            return;
          }
          const port = buf.readUInt16BE(offset);
          const rest = buf.subarray(offset + 2);
          socksTarget = `${host}:${port}`;
          client.off("data", onData);
          const target = net.connect(port, "127.0.0.1", () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (rest.length) target.write(rest);
            target.pipe(client);
            client.pipe(target);
          });
          target.on("error", () => client.destroy());
          client.on("error", () => target.destroy());
        }
      };
      client.on("data", onData);
    });
    await new Promise((resolve) => socksServer.listen(0, "127.0.0.1", resolve));
    const socksPort = socksServer.address().port;

    try {
      const url = `https://daily-cloudcode-pa.googleapis.com:${upstreamPort}/v1internal:loadCodeAssist`;
      const body = Buffer.from('{"metadata":{"ideType":"ANTIGRAVITY"}}');
      const res = await sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok-socks", bodyLength: body.length }),
        body,
        proxyUrl: `socks5h://suser:spass@127.0.0.1:${socksPort}`,
        tls: { rejectUnauthorized: false },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ socks: true });
      expect(res.headers.get("x-9r-proxy-via")).toBe(`socks5h://127.0.0.1:${socksPort}`);
      expect(socksAuth).toBe("suser:spass");
      expect(socksTarget).toBe(`daily-cloudcode-pa.googleapis.com:${upstreamPort}`);
      expect(upstreamSeen[0].map(([k]) => k)).toEqual([
        "Host",
        "User-Agent",
        "Content-Length",
        "Authorization",
        "Content-Type",
        "Accept-Encoding",
      ]);
    } finally {
      resetAntigravityWire();
      socksServer.close();
      upstream.close();
    }
  });

  it("never falls back to direct when a configured proxy fails", async () => {
    const url = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
    await expect(antigravityFetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
      body: "{}",
    }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:1",
      strictProxy: false,
    })).rejects.toThrow();

    await expect(antigravityFetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
      body: "{}",
    }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:1",
      strictProxy: true,
    })).rejects.toThrow(/strictProxy=true/);
  });

  it("offers X25519MLKEM768 + X25519 key shares and HTTP/1.1 ALPN on the Node wire", async () => {
    const { server, port, hello } = await startHelloServer();
    const url = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:loadCodeAssist`;
    try {
      await expect(sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok", bodyLength: 2 }),
        body: Buffer.from("{}"),
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      })).rejects.toThrow();
      const parsed = await hello;
      // Forcing a single curve (the old default) strips MLKEM and only sends X25519.
      expect(parsed.groups).toContain(0x11ec);
      expect(parsed.keyShares).toEqual(expect.arrayContaining([0x11ec, 0x001d]));
      expect(parsed.alpn).toEqual(["http/1.1"]);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("offers h2 first only when the fingerprint says h2", async () => {
    const { server, port, hello } = await startHelloServer();
    const url = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:loadCodeAssist`;
    try {
      await expect(sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok", bodyLength: 2 }),
        body: Buffer.from("{}"),
        alpnProtocol: "h2",
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      })).rejects.toThrow();
      expect((await hello).alpn).toEqual(["h2", "http/1.1"]);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("rejects CRLF/NUL injection in headers, method, token and proxy credentials", async () => {
    const url = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

    expect(() => buildAntigravityHeaders({ url, token: "tok\r\nX-Evil: 1", bodyLength: 2 }))
      .toThrow(/invalid token/);
    await expect(sendWireRequest(url, { method: "POST\r\nX-Evil: 1", headers: [] }))
      .rejects.toThrow(/invalid method/);
    await expect(sendWireRequest(url, {
      method: "POST",
      headers: [["Host", "daily-cloudcode-pa.googleapis.com\r\nX-Evil: 1"]],
    })).rejects.toThrow(/invalid header/);
    await expect(sendWireRequest(url, {
      method: "POST",
      headers: [],
      proxyUrl: "http://user:pa\r\nss@127.0.0.1:1",
    })).rejects.toThrow(/invalid proxy URL/);
    await expect(sendWireRequest(url, {
      method: "POST",
      headers: [],
      proxyUrl: "http://user%ZZpass@127.0.0.1:1",
    })).rejects.toThrow(/malformed credentials/);
  });

  it("rejects an oversized (>64 KiB) response head", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => {
      res.writeHead(200, { "X-Big": "a".repeat(70 * 1024), "Content-Length": "2" });
      res.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:loadCodeAssist`;
    try {
      await expect(sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok", bodyLength: 2 }),
        body: Buffer.from("{}"),
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      })).rejects.toThrow(/response head exceeded/);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("fails closed instead of falling back to undici when the direct wire fails", async () => {
    // Pin the Node transport: the TLS overrides below are test-only and only
    // accepted while AGWIRE_ALLOW_TEST_HOSTS is set.
    const prevBin = process.env.AGWIRE_BIN;
    const prevTest = process.env.AGWIRE_ALLOW_TEST_HOSTS;
    process.env.AGWIRE_BIN = "0";
    process.env.AGWIRE_ALLOW_TEST_HOSTS = "1";
    resetAntigravityWire();
    try {
      const url = "https://daily-cloudcode-pa.googleapis.com:1/v1internal:loadCodeAssist";
      await expect(antigravityFetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: "{}",
        tls: { connectHost: "127.0.0.1" },
      })).rejects.toThrow();

      // A self-signed cert error must also fail closed (no undici insecure retry).
      cert.generateCert();
      const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
      let sawRequest = false;
      const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => {
        sawRequest = true;
        res.writeHead(200);
        res.end("ok");
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      try {
        await expect(antigravityFetch(`https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers: { Authorization: "Bearer tok" },
          body: "{}",
          tls: { connectHost: "127.0.0.1" },
        })).rejects.toThrow();
        expect(sawRequest).toBe(false);
      } finally {
        resetAntigravityWire();
        server.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.AGWIRE_BIN;
      else process.env.AGWIRE_BIN = prevBin;
      if (prevTest === undefined) delete process.env.AGWIRE_ALLOW_TEST_HOSTS;
      else process.env.AGWIRE_ALLOW_TEST_HOSTS = prevTest;
      resetAntigravityWire();
    }
  });

  it("reports node-openssl when the Go sidecar is disabled", () => {
    process.env.AGWIRE_BIN = "0";
    expect(getWireBackendInfo()).toEqual({ backend: "node-openssl", binaryPath: null, active: false });
  });

  it("routes through the agwire sidecar with a per-instance token and full meta", async () => {
    const bin = writeFakeAgwire(tmpDir);
    process.env.AGWIRE_BIN = bin;
    process.env.AGWIRE_ALLOW_TEST_HOSTS = "1";
    resetAntigravityWire();

    expect(getWireBackendInfo()).toEqual({ backend: "go-crypto-tls", binaryPath: bin, active: false });

    const res = await antigravityFetch("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers: { Authorization: "Bearer tok-go" },
      body: '{"x":1}',
      tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-agwire-backend")).toBe("go-crypto-tls");

    const echoed = await res.json();
    expect(echoed.via).toBe("go");
    expect(echoed.token).toMatch(/^[0-9a-f]{64}$/);
    expect(echoed.body).toBe('{"x":1}');
    expect(echoed.headers.map(([k]) => k)).toEqual([
      "Host",
      "User-Agent",
      "Content-Length",
      "Authorization",
      "Content-Type",
      "Accept-Encoding",
    ]);
    expect(echoed.alpn).toEqual(["http/1.1"]);
    expect(echoed.insecureTls).toBe(true);
    expect(echoed.connectHost).toBe("127.0.0.1");
    expect(getWireBackendInfo().active).toBe(true);

    // A snapshot that negotiated h2 must reach the sidecar as ["h2","http/1.1"].
    fs.writeFileSync(path.join(tmpDir, "agy-fingerprint.json"), JSON.stringify({
      version: "1.5.15",
      cl: "1027820220",
      alpnProtocol: "h2",
      uaTemplate: "antigravity/cli/{version} (aidev_client; os_type={os}; arch={arch}; cl={cl}; auth_method=consumer)",
      headers: ["host", "user-agent", "content-length", "authorization", "content-type", "accept-encoding"],
    }));
    resetFingerprintCaches();
    const h2Res = await antigravityFetch("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers: { Authorization: "Bearer tok-h2" },
      body: "{}",
    });
    expect((await h2Res.json()).alpn).toEqual(["h2", "http/1.1"]);

    resetAntigravityWire();
    expect(getWireBackendInfo().active).toBe(false);
  });

  it("surfaces sidecar upstream failures instead of replaying over Node TLS", async () => {
    const bin = writeFakeAgwire(tmpDir);
    process.env.AGWIRE_BIN = bin;
    resetAntigravityWire();
    await expect(antigravityFetch("https://daily-cloudcode-pa.googleapis.com/v1internal:refuse-me", {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
      body: "{}",
    })).rejects.toThrow(/agwire error \(502\): upstream boom/);
    // The sidecar answered (did not crash), so it stays warm for the next call.
    expect(getWireBackendInfo().active).toBe(true);
  });

  it("falls back to the Node TLS wire when the sidecar IPC fails, then fails closed", async () => {
    const marker = path.join(tmpDir, "broken-spawned");
    const bin = path.join(tmpDir, "broken-agwire");
    fs.writeFileSync(bin, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");
console.log("not a port line");
process.stdin.resume();
`, { mode: 0o755 });
    process.env.AGWIRE_BIN = bin;
    process.env.AGWIRE_ALLOW_TEST_HOSTS = "1";
    resetAntigravityWire();
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    const seen = [];
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      const pairs = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) pairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      seen.push(pairs);
      const body = '{"via":"node"}';
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const okRes = await antigravityFetch(`https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: "{}",
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      });
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toEqual({ via: "node" });
      expect(seen[0].map(([k]) => k)).toEqual([
        "Host",
        "User-Agent",
        "Content-Length",
        "Authorization",
        "Content-Type",
        "Accept-Encoding",
      ]);
      expect(fs.existsSync(marker)).toBe(true);
      expect(getWireBackendInfo().active).toBe(false);
      await expect(antigravityFetch("https://daily-cloudcode-pa.googleapis.com:1/v1internal:loadCodeAssist", {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: "{}",
        tls: { connectHost: "127.0.0.1" },
      })).rejects.toThrow();
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });
});

describe("antigravityWire: replay and socket safety", () => {
  let tmpDir;
  const prevEnv = {
    DATA_DIR: process.env.DATA_DIR,
    AGWIRE_BIN: process.env.AGWIRE_BIN,
    AGWIRE_ALLOW_TEST_HOSTS: process.env.AGWIRE_ALLOW_TEST_HOSTS,
    NO_PROXY: process.env.NO_PROXY,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-wire-replay-"));
    process.env.DATA_DIR = tmpDir;
    process.env.AGWIRE_BIN = "0";
    process.env.NO_PROXY = "*";
    delete process.env.AGWIRE_ALLOW_TEST_HOSTS;
    resetFingerprintCaches();
    resetAntigravityWire();
  });

  afterEach(() => {
    resetAntigravityWire();
    resetFingerprintCaches();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never replays a POST when the sidecar dies after receiving it", async () => {
    const bin = path.join(tmpDir, "dropping-agwire");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const http = require("node:http");
const server = http.createServer((req) => {
  req.on("data", () => {});
  req.on("end", () => req.socket.destroy());
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
    process.env.AGWIRE_BIN = bin;
    // The sidecar path is gated on this flag because the tls fixture pins connectHost.
    process.env.AGWIRE_ALLOW_TEST_HOSTS = "1";
    resetAntigravityWire();

    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    let served = 0;
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      served++;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "2" });
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      await expect(antigravityFetch(`https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: '{"x":1}',
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      })).rejects.toThrow();
      // The sidecar already had the request; a Node TLS replay would double the turn.
      expect(served).toBe(0);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("parks a keep-alive socket even when the body arrives in a later packet", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    let conns = 0;
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "11" });
      setTimeout(() => res.end('{"ok":true}'), 40);
    });
    server.on("connection", () => { conns++; });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:loadCodeAssist`;
    try {
      for (let i = 0; i < 3; i++) {
        const body = Buffer.from("{}");
        const res = await sendWireRequest(url, {
          method: "POST",
          headers: buildAntigravityHeaders({ url, token: "tok", bodyLength: body.length }),
          body,
          origin: `https://127.0.0.1:${port}`,
          tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
        });
        expect(await res.json()).toEqual({ ok: true });
      }
      expect(conns).toBe(1);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("does not replay a reused socket after a partial response head", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    let served = 0;
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      served++;
      if (served === 1) {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "2" });
        res.end("{}");
        return;
      }
      req.socket.write("HTTP/1.1 200 OK\r\nContent-Le");
      setTimeout(() => req.socket.destroy(), 20);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:streamGenerateContent?alt=sse`;
    const options = () => ({
      method: "POST",
      headers: buildAntigravityHeaders({ url, token: "tok", bodyLength: 2 }),
      body: Buffer.from("{}"),
      origin: `https://127.0.0.1:${port}`,
      tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
    });
    try {
      const first = await sendWireRequest(url, options());
      await first.text();
      await expect(sendWireRequest(url, options())).rejects.toThrow(/head|closed/i);
      expect(served).toBe(2);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("fails closed on an invalid Content-Length instead of hanging", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "abc" });
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:loadCodeAssist`;
    try {
      await expect(sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok", bodyLength: 2 }),
        body: Buffer.from("{}"),
        origin: `https://127.0.0.1:${port}`,
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      })).rejects.toThrow(/invalid Content-Length/);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("reports an already-aborted signal as AbortError so the executor can tell it apart", async () => {
    const controller = new AbortController();
    controller.abort();
    let caught;
    try {
      await antigravityFetch("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: "{}",
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught?.name).toBe("AbortError");
    expect(caught?.message).toMatch(/aborted/);
  });

  it("rejects a truncated chunked response instead of returning a clean EOF", async () => {
    cert.generateCert();
    const leaf = cert.getCertForDomain("daily-cloudcode-pa.googleapis.com");
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      req.resume();
      req.socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n");
      setTimeout(() => req.socket.destroy(), 20);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `https://daily-cloudcode-pa.googleapis.com:${port}/v1internal:streamGenerateContent?alt=sse`;
    try {
      const res = await sendWireRequest(url, {
        method: "POST",
        headers: buildAntigravityHeaders({ url, token: "tok", bodyLength: 2 }),
        body: Buffer.from("{}"),
        origin: `https://127.0.0.1:${port}`,
        tls: { connectHost: "127.0.0.1", rejectUnauthorized: false },
      });
      await expect(res.text()).rejects.toThrow(/chunked|closed|aborted/i);
    } finally {
      resetAntigravityWire();
      server.close();
    }
  });

  it("treats an explicit missing AGWIRE_BIN path as disabled instead of falling back to repo binary", () => {
    process.env.AGWIRE_BIN = path.join(tmpDir, "does-not-exist");
    expect(getWireBackendInfo()).toEqual({ backend: "node-openssl", binaryPath: null, active: false });
  });
});
