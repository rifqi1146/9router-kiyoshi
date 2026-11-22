import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  resetFingerprintCaches,
} = await import("../../open-sse/services/antigravityFingerprint.js");

const {
  buildAntigravityHeaders,
  buildAntigravityHeaderObject,
  sendWireRequest,
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
    expect(bundled.version).toBe("1.5.14");
    expect(bundled.cl).toBe("1026970498");
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
});

describe("antigravityWire", () => {
  afterEach(() => {
    resetAntigravityWire();
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
});
