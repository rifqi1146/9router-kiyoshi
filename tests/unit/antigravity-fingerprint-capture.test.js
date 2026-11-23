// Guards the recorder's ALPN honesty and multi-endpoint capture: the snapshot
// must report the protocol the binary negotiated, not the one the recorder
// offered, and a binary that stops after preflight must still produce a
// snapshot instead of burning the full timeout.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildUserAgent, captureFingerprint, detectBinaryVersion, getFingerprint, resetFingerprintCaches } = await import(
  "../../open-sse/services/antigravityFingerprint.js"
);

const UA = "antigravity/cli/1.5.99 (aidev_client; os_type=linux; arch=amd64; cl=1099999999; auth_method=consumer)";

const PREAMBLE = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.5.99"); process.exit(0); }
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const host = "daily-cloudcode-pa.googleapis.com";
const proxy = new URL(process.env.HTTPS_PROXY);
const sock = net.connect(Number(proxy.port), proxy.hostname, () => {
  sock.write("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\n\\r\\n");
});
let buf = "";
sock.on("data", (d) => {
  buf += d.toString();
  if (!buf.includes("\\r\\n\\r\\n")) return;
  sock.removeAllListeners("data");
  connect();
});
`;

// One HTTP/2 session, two endpoints, both carrying the same header set.
const H2_MOCK = `${PREAMBLE}function connect() {
  const http2 = require("node:http2");
  const ts = tls.connect({
    socket: sock,
    servername: host,
    ca: fs.readFileSync(process.env.SSL_CERT_FILE),
    ALPNProtocols: ["h2", "http/1.1"],
  }, () => {
    if (ts.alpnProtocol !== "h2") process.exit(3); // the recorder must offer h2
    const client = http2.connect("https://" + host, { createConnection: () => ts });
    const send = (p, body, after) => {
      const req = client.request({
        ":method": "POST",
        ":path": p,
        "user-agent": ${JSON.stringify(UA)},
        authorization: "Bearer dummy",
        "content-type": "application/json",
        "accept-encoding": "gzip",
        "content-length": String(Buffer.byteLength(body)),
      });
      req.end(body);
      req.resume();
      req.on("end", after);
    };
    send("/v1internal:loadCodeAssist", JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }), () => {
      send("/v1internal:streamGenerateContent?alt=sse", JSON.stringify({ contents: [] }), () => {
        client.close();
        process.exit(0);
      });
    });
  });
  ts.on("error", () => process.exit(4));
}
`;

// HTTP/1.1 only: a client that offers no h2 gets http/1.1 back.
const H1_MOCK = `${PREAMBLE}function connect() {
  const ts = tls.connect({
    socket: sock,
    servername: host,
    ca: fs.readFileSync(process.env.SSL_CERT_FILE),
  }, () => {
    const body = JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } });
    ts.write([
      "POST /v1internal:loadCodeAssist HTTP/1.1",
      "Host: " + host,
      "User-Agent: ${UA}",
      "Content-Length: " + body.length,
      "Authorization: Bearer dummy",
      "Content-Type: application/json",
      "Accept-Encoding: gzip",
      "",
      body,
    ].join("\\r\\n"));
  });
  ts.on("data", () => process.exit(0));
  ts.on("error", () => process.exit(4));
}
`;

// Sends userinfo on www.googleapis.com first, then loadCodeAssist and streamGenerateContent with an extra header.
const DIVERGENT_MOCK = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.5.99"); process.exit(0); }
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const http2 = require("node:http2");
const proxy = new URL(process.env.HTTPS_PROXY);
function tunnel(host, cb) {
  const sock = net.connect(Number(proxy.port), proxy.hostname, () => {
    sock.write("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\n\\r\\n");
  });
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    if (!buf.includes("\\r\\n\\r\\n")) return;
    sock.removeAllListeners("data");
    cb(sock);
  });
}
tunnel("www.googleapis.com", (uSock) => {
  const uts = tls.connect({ socket: uSock, servername: "www.googleapis.com", ca: fs.readFileSync(process.env.SSL_CERT_FILE) }, () => {
    uts.write("GET /oauth2/v2/userinfo HTTP/1.1\\r\\nHost: www.googleapis.com\\r\\nUser-Agent: Go-http-client/1.1\\r\\nAuthorization: Bearer dummy\\r\\nAccept-Encoding: gzip\\r\\n\\r\\n");
  });
  uts.on("data", () => {
    uts.destroy();
    tunnel("daily-cloudcode-pa.googleapis.com", (cSock) => {
      const ts = tls.connect({ socket: cSock, servername: "daily-cloudcode-pa.googleapis.com", ca: fs.readFileSync(process.env.SSL_CERT_FILE), ALPNProtocols: ["h2", "http/1.1"] }, () => {
        const client = http2.connect("https://daily-cloudcode-pa.googleapis.com", { createConnection: () => ts });
        const send = (p, extra, after) => {
          const req = client.request({
            ":method": "POST",
            ":path": p,
            "user-agent": ${JSON.stringify(UA)},
            authorization: "Bearer dummy",
            "content-type": "application/json",
            "accept-encoding": "gzip",
            ...extra,
          });
          req.end("{}");
          req.resume();
          req.on("end", after);
        };
        send("/v1internal:loadCodeAssist", {}, () => {
          send("/v1internal:streamGenerateContent?alt=sse", { "x-stream-only": "1" }, () => {
            client.close();
            process.exit(0);
          });
        });
      });
    });
  });
});
`;

describe("captureFingerprint ALPN and endpoint coverage", () => {
  let tmpDir;
  const prevDataDir = process.env.DATA_DIR;
  const prevAgyBin = process.env.AGY_BIN;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-fp-capture-"));
    process.env.DATA_DIR = tmpDir;
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

  function fakeBinary(source) {
    const bin = path.join(tmpDir, "agy");
    fs.writeFileSync(bin, source, { mode: 0o755 });
    process.env.AGY_BIN = bin;
    resetFingerprintCaches();
  }

  it("records h2 when the binary negotiates HTTP/2, across both endpoints", async () => {
    fakeBinary(H2_MOCK);
    const snap = await captureFingerprint({ timeoutMs: 10_000 });

    expect(snap).toBeTruthy();
    expect(snap.alpnProtocol).toBe("h2");
    expect(snap.capturedFrom.alpnProtocol).toBe("h2");
    expect(snap.capturedFrom.httpVersion).toBe("HTTP/2.0");
    expect(snap.capturedFrom.path).toBe("/v1internal:loadCodeAssist");
    expect(snap.capturedFrom.endpoints.loadCodeAssist.alpnProtocol).toBe("h2");
    expect(snap.capturedFrom.endpoints.loadCodeAssist.headers).toEqual([
      "user-agent",
      "authorization",
      "content-type",
      "accept-encoding",
      "content-length",
    ]);
    expect(snap.capturedFrom.endpoints.streamGenerateContent.path).toBe("/v1internal:streamGenerateContent?alt=sse");
    expect(snap.capturedFrom.endpoints.streamGenerateContent.alpnProtocol).toBe("h2");
    // Same header set on both calls: no divergence to report.
    expect(snap.streamHeaders).toBeUndefined();
    expect(snap.cl).toBe("1099999999");
  });

  it("records http/1.1 when the binary negotiates HTTP/1.1", async () => {
    fakeBinary(H1_MOCK);
    const snap = await captureFingerprint({ timeoutMs: 10_000 });

    expect(snap).toBeTruthy();
    expect(snap.alpnProtocol).toBe("http/1.1");
    expect(snap.capturedFrom.httpVersion).toBe("HTTP/1.1");
    expect(snap.capturedFrom.endpoints.loadCodeAssist.httpVersion).toBe("HTTP/1.1");
    expect(snap.capturedFrom.endpoints.streamGenerateContent).toBeUndefined();
    expect(snap.headers).toEqual([
      "host",
      "user-agent",
      "content-length",
      "authorization",
      "content-type",
      "accept-encoding",
    ]);
  });

  it("fails open on a preflight-only binary without waiting the full timeout", async () => {
    fakeBinary(H1_MOCK);
    const startedAt = Date.now();
    const snap = await captureFingerprint({ timeoutMs: 15_000 });
    const elapsed = Date.now() - startedAt;

    expect(snap).toBeTruthy();
    expect(snap.capturedFrom.endpoints.loadCodeAssist.path).toBe("/v1internal:loadCodeAssist");
    expect(elapsed).toBeLessThan(5_000);
  });
  it("ignores www.googleapis.com preflight and records streamHeaders when stream differs", async () => {
    fakeBinary(DIVERGENT_MOCK);
    const snap = await captureFingerprint({ timeoutMs: 10_000 });

    expect(snap).toBeTruthy();
    expect(snap.capturedFrom.host).toBe("daily-cloudcode-pa.googleapis.com");
    expect(snap.headers).toEqual(["user-agent", "authorization", "content-type", "accept-encoding"]);
    expect(snap.streamHeaders).toEqual(["user-agent", "authorization", "content-type", "accept-encoding", "x-stream-only"]);
  });

  it("resolves alpnProtocol in getFingerprint from top-level, capturedFrom, or http/1.1 fallback", () => {
    process.env.AGY_BIN = path.join(tmpDir, "missing-agy");
    const snapFile = path.join(tmpDir, "agy-fingerprint.json");

    fs.writeFileSync(snapFile, JSON.stringify({
      version: "1.5.15",
      alpnProtocol: "h2",
      headers: ["user-agent", "authorization", "content-type", "accept-encoding"],
    }));
    resetFingerprintCaches();
    expect(getFingerprint({ probe: false }).alpnProtocol).toBe("h2");

    fs.writeFileSync(snapFile, JSON.stringify({
      version: "1.5.15",
      headers: ["host", "user-agent", "authorization", "content-type"],
      capturedFrom: { alpnProtocol: "h2" },
    }));
    resetFingerprintCaches();
    expect(getFingerprint({ probe: false }).alpnProtocol).toBe("h2");

    fs.writeFileSync(snapFile, JSON.stringify({
      version: "1.5.15",
      headers: ["host", "user-agent", "authorization", "content-type"],
    }));
    resetFingerprintCaches();
    expect(getFingerprint({ probe: false }).alpnProtocol).toBe("http/1.1");
  });

  it("caches a failed version probe instead of re-execing it on every poll", () => {
    const calls = path.join(tmpDir, "version-calls");
    const bin = path.join(tmpDir, "agy-broken");
    fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${calls}"\nexit 1\n`, { mode: 0o755 });
    process.env.AGY_BIN = bin;
    resetFingerprintCaches();

    expect(detectBinaryVersion()).toBeNull();
    expect(detectBinaryVersion()).toBeNull();
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("fails open without crashing when the binary cannot exec", async () => {
    const bin = path.join(tmpDir, "agy-noexec");
    fs.writeFileSync(bin, "#!/usr/bin/env node\n", { mode: 0o644 });
    process.env.AGY_BIN = bin;
    resetFingerprintCaches();

    // spawn emits `error`, never `exit`; an unhandled one would kill the server.
    await expect(captureFingerprint({ timeoutMs: 3_000 })).resolves.toBeNull();
  });

  it("clamps a junk ALPN and survives a malformed uaTemplate in the snapshot", () => {
    fs.writeFileSync(path.join(tmpDir, "agy-fingerprint.json"), JSON.stringify({
      version: "1.5.15",
      alpnProtocol: "h3",
      uaTemplate: 42,
      headers: ["host", "user-agent", "content-length", "authorization"],
    }));
    resetFingerprintCaches();

    const fp = getFingerprint({ probe: false });
    expect(fp.source).toBe("snapshot");
    expect(fp.alpnProtocol).toBe("http/1.1");
    expect(buildUserAgent(fp)).toContain("antigravity/cli/");
  });

});
