/**
 * Antigravity client fingerprint, sourced from the installed `agy` binary.
 *
 * The native client is a Go binary that checks Google's release manifest when a
 * session starts, not when `--version` is read. An install nothing prompts stays
 * frozen on its release, and our fingerprint follows it down. Hand-written
 * version/UA/header constants are stale by construction, so this module removes
 * both as maintenance items:
 *
 *   1. `agy --version` gives the live version.
 *   2. When the stored snapshot disagrees, the binary is spawned once behind a
 *      local CONNECT recorder. The probe uses a throwaway profile holding a
 *      dummy token, so it needs no account and never reaches Google with real
 *      credentials; the recorder answers every request itself.
 *   3. The observed request line and headers are stored as JSON under DATA_DIR
 *      and consumed by `open-sse/utils/antigravityWire.js`.
 *
 * Fail-open: a failed capture keeps the previous snapshot. A bundled snapshot
 * (`config/agy-fingerprint.default.json`) covers a fresh install where the
 * binary has not been probed yet.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import http2 from "node:http2";
import tls from "node:tls";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ANTIGRAVITY_CLI_VERSION, ANTIGRAVITY_IDE_USER_AGENT } from "../providers/shared.js";
import { dbg } from "../utils/debugLog.js";

const SNAPSHOT_FILE = "agy-fingerprint.json";
const VERSION_CACHE_MS = 5 * 60 * 1000;
const SNAPSHOT_RECHECK_MS = 10 * 1000;
const SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
// `agy` throttles its own manifest check to 15 min; keep ours below the 30 min
// sync tick (with margin for the 5s startup delay and timer jitter) so every
// tick runs while bursts still coalesce.
const UPDATE_MIN_INTERVAL_MS = 25 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const CAPTURE_TIMEOUT_MS = 20_000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Captured 2026-11-23 from agy 1.5.15, `/v1internal:loadCodeAssist`. */
export const DEFAULT_HEADERS = [
  "host",
  "user-agent",
  "content-length",
  "authorization",
  "content-type",
  "accept-encoding",
];

const MODULE_DIR = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

function resolveDataDir() {
  const configured = process.env.DATA_DIR;
  if (configured) {
    try { fs.mkdirSync(configured, { recursive: true }); return configured; } catch { /* fall through */ }
  }
  return path.join(os.homedir(), ".9router");
}

export function snapshotPath() {
  return path.join(resolveDataDir(), SNAPSHOT_FILE);
}

export function binaryPath() {
  return process.env.AGY_BIN || path.join(os.homedir(), ".local", "bin", "agy");
}

let versionCache = { at: 0, version: null };
let snapshotCache = { at: 0, mtimeMs: -1, data: null };
let syncState = { inflight: null, lastAttemptAt: 0, timer: null, startupTimer: null };
let updateState = { inflight: null, lastAttemptAt: 0 };

/** Live `agy --version`, cached. Null when the binary is absent or unreadable. */
export function detectBinaryVersion() {
  const now = Date.now();
  if (now - versionCache.at < VERSION_CACHE_MS) return versionCache.version;
  const bin = binaryPath();
  if (!fs.existsSync(bin)) return null;
  try {
    const out = execFileSync(bin, ["--version"], { timeout: 4000, encoding: "utf8" });
    const line = String(out || "").split("\n").map((l) => l.trim()).find((l) => VERSION_RE.test(l));
    versionCache = { at: now, version: line || null };
    return versionCache.version;
  } catch {
    // Cache the failure too: a binary that hangs or refuses costs 4s of
    // blocking exec, and the dashboard polls this endpoint every minute.
    versionCache = { at: now, version: null };
    return null;
  }
}

function isValidSnapshot(data) {
  return !!data
    && typeof data.version === "string"
    && Array.isArray(data.headers)
    && data.headers.length >= 4
    && data.headers.every((h) => typeof h === "string" && h.length > 0);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** First existing candidate; standalone builds move config/ and src/ around. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return null;
}

function bundledSnapshotPath() {
  return firstExisting([
    path.join(MODULE_DIR, "..", "config", "agy-fingerprint.default.json"),
    path.join(process.cwd(), "open-sse", "config", "agy-fingerprint.default.json"),
    path.join(process.cwd(), "app", "open-sse", "config", "agy-fingerprint.default.json"),
  ]);
}

/**
 * Snapshot with the widest provenance: a live capture under DATA_DIR, else the
 * snapshot bundled at build time.
 */
export function readSnapshot() {
  const file = snapshotPath();
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (stat) {
    const now = Date.now();
    if (snapshotCache.data && snapshotCache.mtimeMs === stat.mtimeMs && now - snapshotCache.at < SNAPSHOT_RECHECK_MS) {
      return snapshotCache.data;
    }
    const data = readJson(file);
    if (isValidSnapshot(data)) {
      const tagged = { ...data, _origin: "live" };
      snapshotCache = { at: now, mtimeMs: stat.mtimeMs, data: tagged };
      return tagged;
    }
  }
  const bundledFile = bundledSnapshotPath();
  const bundled = bundledFile ? readJson(bundledFile) : null;
  return isValidSnapshot(bundled) ? { ...bundled, _origin: "bundled" } : null;
}

const OS_NAMES = { darwin: "darwin", win32: "windows", freebsd: "freebsd", linux: "linux" };
const ARCH_NAMES = { x64: "amd64", arm64: "arm64", ia32: "386" };

/** Native UA params, in the order the client emits them. */
export function buildUserAgent(fp = getFingerprint({ probe: false })) {
  const template = typeof fp?.uaTemplate === "string" ? fp.uaTemplate : null;
  const literal = typeof fp?.ua === "string" ? fp.ua : null;
  if (!template) return literal || ANTIGRAVITY_IDE_USER_AGENT;
  const osName = OS_NAMES[process.platform] || "linux";
  const arch = ARCH_NAMES[process.arch] || process.arch || "amd64";
  let ua = template
    .replaceAll("{version}", fp.version || ANTIGRAVITY_CLI_VERSION)
    .replaceAll("{cl}", fp.cl || "")
    .replaceAll("{os}", osName)
    .replaceAll("{arch}", arch);
  // Never leave an empty parameter behind: `cl=` with no value is its own tell.
  ua = ua.replace(/;\s*cl=\s*(?=[;)])/g, "").replace(/cl=\s*(?=[;)])/g, "");
  return ua;
}

/**
 * Fingerprint used for outbound requests.
 * `source: "snapshot"` = captured from the binary; `"default"` = no snapshot.
 */
export function getFingerprint({ probe = true } = {}) {
  const snapshot = readSnapshot();
  const liveVersion = probe ? detectBinaryVersion() : versionCache.version;
  const base = snapshot || {
    version: liveVersion || ANTIGRAVITY_CLI_VERSION,
    cl: null,
    uaTemplate: null,
    ua: ANTIGRAVITY_IDE_USER_AGENT,
    headers: DEFAULT_HEADERS,
    capturedAt: null,
    _origin: "default",
  };
  const source = base._origin === "live" ? "snapshot" : base._origin === "bundled" ? "bundled" : "default";
  // A hand-edited or newer snapshot may name a protocol this wire cannot send;
  // report HTTP/1.1 so the API and the sender agree on one value.
  const negotiated = base.alpnProtocol || base.capturedFrom?.alpnProtocol;
  return {
    ...base,
    alpnProtocol: negotiated === "h2" ? "h2" : "http/1.1",
    liveVersion,
    stale: !!(liveVersion && base.version && liveVersion !== base.version),
    source,
  };
}

/**
 * Run `agy update` so the binary tracks Google's release on a host that never
 * starts a real CLI session. Async: a behind binary downloads ~101 MB and must
 * never block the event loop. Never throws.
 */
export function updateBinary({ force = false, timeoutMs = UPDATE_TIMEOUT_MS } = {}) {
  if (process.env.ANTIGRAVITY_AGY_UPDATE === "0") return Promise.resolve(false);
  if (updateState.inflight) return updateState.inflight;
  const now = Date.now();
  if (!force && now - updateState.lastAttemptAt < UPDATE_MIN_INTERVAL_MS) return Promise.resolve(false);
  const bin = binaryPath();
  if (!fs.existsSync(bin)) return Promise.resolve(false);
  updateState.lastAttemptAt = now; // set first: concurrent ticks must not double-spawn
  let child;
  try {
    // stdio ignore: `update` streams a ~101 MB download's progress, and
    // execFile's 1 MB maxBuffer killed the update before it finished.
    child = spawn(bin, ["update"], { stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (error) {
    // Spawned synchronously so a throw here cannot be assigned over: the
    // executor of `new Promise` runs before `updateState.inflight` is set, so a
    // `finish()` inside it would be clobbered by the assignment.
    dbg("AG_FP", `agy update failed: ${error.message}`);
    return Promise.resolve(false);
  }
  updateState.inflight = new Promise((resolve) => {
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      updateState.inflight = null;
      if (ok) versionCache = { at: 0, version: null };
      else dbg("AG_FP", `agy update failed: ${detail}`);
      resolve(ok);
    };
    child.once("error", (error) => finish(false, error.message));
    child.once("exit", (code, signal) => finish(code === 0, `code=${code ?? "null"} signal=${signal ?? "none"}`));
  });
  return updateState.inflight;
}

export function needsRefresh() {
  const snapshot = readSnapshot();
  const liveVersion = detectBinaryVersion();
  if (!liveVersion) return false;
  // Capture once on this machine when only the bundled fallback exists, or when
  // the installed binary moved past the last live capture.
  return !snapshot || snapshot._origin !== "live" || snapshot.version !== liveVersion;
}

/** Parse one raw HTTP/1.1 request head. Exported for tests. */
export function parseCapturedRequest(raw) {
  const head = String(raw || "").split("\r\n\r\n")[0];
  const lines = head.split("\r\n").filter(Boolean);
  if (lines.length < 2) return null;
  const [method, requestPath, httpVersion] = lines[0].split(" ");
  const headers = [];
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers.push([line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]);
  }
  return { method, path: requestPath, httpVersion, headers };
}

/**
 * Turn a captured UA into a template so version/os/arch stay dynamic and only
 * the literal shape is frozen.
 */
export function uaToTemplate(ua, { cl, version }) {
  if (typeof ua !== "string" || !ua) return null;
  let out = ua
    .replace(/;\s*host_path=[^;)]*/g, "")
    .replace(/\s*\(([^)]*?)\s*\)\s*$/, (m, inner) => ` (${inner.replace(/\s*;\s*host_path=[^;)]*/g, "")})`);
  if (version) out = out.replaceAll(version, "{version}");
  if (cl) out = out.replaceAll(`cl=${cl}`, "cl={cl}");
  out = out.replace(/os_type=[a-z0-9]+/i, "os_type={os}").replace(/arch=[a-z0-9_]+/i, "arch={arch}");
  return out.replace(/\(\s*;\s*/g, "(").replace(/;\s*\)/g, ")");
}

const CLOUD_CODE_HOSTS = new Set([
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "aicode.googleapis.com",
]);
const MIRRORED_HOSTS = new Set([
  ...CLOUD_CODE_HOSTS,
  // agy resolves the account through `oauth2/v2/userinfo` and aborts the turn
  // when that host is unreachable, so the probe never reaches the stream call.
  "www.googleapis.com",
]);

// During a probe the recorder is the whole upstream: these bodies replace
// Google's answers, so each one is shaped just far enough for the client to
// walk its preflight and open one streaming turn.
const LOAD_CODE_ASSIST_BODY = JSON.stringify({
  cloudaicompanionProject: "aicode-consumers",
  currentTier: { id: "free-tier", name: "Free" },
  allowedTiers: [{ id: "free-tier", isDefault: true }],
});
const AVAILABLE_MODELS_BODY = JSON.stringify({
  models: {
    "gemini-3.8-flash-high": {
      model: "MODEL_PLACEHOLDER_M47",
      apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
      modelProvider: "MODEL_PROVIDER_GOOGLE",
      recommended: true,
    },
  },
  defaultAgentModelId: "gemini-3.8-flash-high",
  agentModelSorts: [{ displayName: "Recommended", groups: [{ modelIds: ["gemini-3.8-flash-high"] }] }],
});
const STREAM_PROBE_BODY = "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}}\n\n";
const EXIT_GRACE_MS = 250;

function mockResponseFor(requestPath) {
  if (requestPath.includes("streamGenerateContent")) return { type: "text/event-stream", body: STREAM_PROBE_BODY };
  if (requestPath.includes("loadCodeAssist")) return { type: "application/json", body: LOAD_CODE_ASSIST_BODY };
  if (requestPath.includes("fetchAvailableModels")) return { type: "application/json", body: AVAILABLE_MODELS_BODY };
  return { type: "application/json", body: "{}" };
}

async function loadCertModule() {
  // Webpack rewrites static `createRequire` imports to a stub that returns
  // undefined; load `node:module` dynamically with webpackIgnore so the
  // standalone server can still load the MITM CA generator at runtime.
  const { createRequire } = await import(/* webpackIgnore: true */ "node:module");
  const roots = [
    path.join(MODULE_DIR, "..", ".."),
    process.cwd(),
    path.join(process.cwd(), "app"),
  ];
  for (const root of roots) {
    const srcRoot = path.join(root, "src", "mitm");
    if (!fs.existsSync(srcRoot)) continue;
    try {
      const req = createRequire(path.join(root, "package.json"));
      const cert = req(path.join(srcRoot, "cert", "generate.js"));
      // Root CA location belongs to the MITM module: it resolves DATA_DIR once
      // at load time, so recomputing it here can disagree after DATA_DIR moves.
      const mitmDir = req(path.join(srcRoot, "paths.js")).MITM_DIR;
      return { cert, mitmDir };
    } catch {
      // node-forge missing in this root (dynamic require is not traced): try
      // the next candidate, and let capture fail open if none work.
    }
  }
  return null;
}

/**
 * Localhost CONNECT recorder that answers every mirrored request itself.
 *
 * Both ALPN protocols are offered because the negotiated one is the binary's
 * choice: a recorder that only speaks `http/1.1` makes every capture report
 * HTTP/1.1 whether or not the client asked for HTTP/2.
 */
function startRecorder({ cert, onRequest }) {
  const secure = http2.createSecureServer({
    allowHTTP1: true,
    ALPNProtocols: ["h2", "http/1.1"],
    SNICallback: (servername, cb) => {
      let leaf = null;
      try { leaf = cert.getCertForDomain(servername || "daily-cloudcode-pa.googleapis.com"); } catch { leaf = null; }
      if (!leaf) { cb(new Error("no leaf certificate")); return; }
      cb(null, tls.createSecureContext({ key: leaf.key, cert: leaf.cert }));
    },
  });
  const sessions = new Set();
  secure.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  secure.on("request", (req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = String(req.rawHeaders[i]).toLowerCase();
      // HTTP/2 carries method, path and authority as pseudo-headers; those are
      // reported as fields, not copied into the ordered header list.
      if (name.startsWith(":")) continue;
      headers.push([name, String(req.rawHeaders[i + 1])]);
    }
    const parsed = {
      method: req.method,
      path: req.url,
      httpVersion: req.httpVersion === "2.0" ? "HTTP/2.0" : "HTTP/1.1",
      headers,
    };
    const host = String(req.socket?.servername || req.headers[":authority"] || req.headers.host || "").split(":")[0];
    const alpnProtocol = req.socket?.alpnProtocol || "http/1.1";
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try { onRequest({ host, parsed, body: Buffer.concat(chunks), alpnProtocol }); } catch { /* recorder stays up */ }
      const mock = mockResponseFor(parsed.path);
      try {
        res.writeHead(200, { "content-type": mock.type });
        res.end(mock.body);
      } catch { /* client gone */ }
    });
  });
  secure.on("error", () => {});

  const sockets = new Set();
  const proxy = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (req, clientSocket, head) => {
    const host = String(req.url || "").split(":")[0];
    if (!MIRRORED_HOSTS.has(host)) { clientSocket.destroy(); return; }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) clientSocket.unshift(head);
    secure.emit("connection", clientSocket);
  });
  proxy.on("error", () => {});
  return { proxy, secure, sockets, sessions };
}

function describeEndpoint(request) {
  return {
    path: request.parsed.path,
    httpVersion: request.parsed.httpVersion,
    alpnProtocol: request.alpnProtocol,
    headers: request.parsed.headers.map(([name]) => name),
  };
}

/**
 * Probe the installed binary against the recorder and return its request shape.
 * Uses a throwaway HOME containing a dummy token, so no account is involved.
 */
export async function captureFingerprint({ timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  if (process.env.ANTIGRAVITY_FINGERPRINT_CAPTURE === "0") return null;
  const bin = binaryPath();
  if (!fs.existsSync(bin)) return null;

  let certModule;
  try { certModule = await loadCertModule(); } catch { return null; }
  if (!certModule) return null;
  const rootCA = path.join(certModule.mitmDir, "rootCA.crt");
  try { if (!fs.existsSync(rootCA)) certModule.cert.generateCert(); } catch { return null; }
  if (!fs.existsSync(rootCA)) return null;
  const cert = certModule.cert;

  const captured = { first: null, loadCodeAssist: null, streamGenerateContent: null };
  const recorder = startRecorder({
    cert,
    onRequest: (request) => {
      if (!CLOUD_CODE_HOSTS.has(request.host)) return;
      if (!captured.first) captured.first = request;
      if (request.parsed.path.includes("loadCodeAssist")) captured.loadCodeAssist ||= request;
      else if (request.parsed.path.includes("streamGenerateContent")) captured.streamGenerateContent ||= request;
    },
  });
  const port = await new Promise((resolve) => {
    const onError = () => resolve(0);
    recorder.proxy.once("error", onError);
    recorder.proxy.listen(0, "127.0.0.1", () => {
      recorder.proxy.off("error", onError);
      resolve(recorder.proxy.address().port);
    });
  });

  let home = null;
  let child = null;
  try {
    if (!port) throw new Error("recorder could not bind loopback");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fp-"));
    const profile = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(profile, { recursive: true });
    // Dummy credentials: the recorder answers, so nothing reaches Google.
    fs.writeFileSync(path.join(profile, "antigravity-oauth-token"), JSON.stringify({
      token: {
        access_token: "dummy-fingerprint-probe",
        token_type: "Bearer",
        refresh_token: "dummy-fingerprint-probe",
        expiry: "2099-01-01T00:00:00Z",
        expires_in: 3600,
      },
      auth_method: "consumer",
      id_token_email: "probe@localhost.invalid",
    }));
    const work = path.join(home, "work");
    fs.mkdirSync(work, { recursive: true });
    child = spawn(bin, ["--model", "gemini-3.8-flash-high", "-p", "fp-probe"], {
      cwd: work,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        HOME: home,
        HTTPS_PROXY: `http://127.0.0.1:${port}`,
        HTTP_PROXY: `http://127.0.0.1:${port}`,
        NO_PROXY: "",
        SSL_CERT_FILE: rootCA,
      },
    });
  } catch (error) {
    dbg("AG_FP", `probe could not start: ${error.message}`);
    if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
    try { recorder.proxy.close(); } catch { /* ignore */ }
    try { recorder.secure.close(); } catch { /* ignore */ }
    return null;
  }

  let exitedAt = 0;
  child.once("exit", () => { exitedAt = Date.now(); });
  // A file that exists but cannot exec (bad interpreter, EACCES, missing ELF
  // loader) emits `error` and never `exit`; unhandled, that exception kills the
  // server. Treat it as an early exit so the probe fails open immediately.
  child.once("error", (error) => {
    dbg("AG_FP", `probe failed to run: ${error.message}`);
    exitedAt ||= Date.now();
  });

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (captured.loadCodeAssist && captured.streamGenerateContent) break;
      // A binary that answers the probe and exits (or gives up) must not cost
      // the full timeout: give in-flight stream bytes a short grace, then stop.
      if (exitedAt && Date.now() - exitedAt >= EXIT_GRACE_MS) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    for (const session of recorder.sessions) { try { session.destroy(); } catch { /* ignore */ } }
    for (const socket of recorder.sockets) { try { socket.destroy(); } catch { /* ignore */ } }
    try { recorder.proxy.close(); } catch { /* ignore */ }
    try { recorder.secure.close(); } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const primary = captured.loadCodeAssist || captured.first;
  if (!primary) return null;

  const headerMap = new Map(primary.parsed.headers);
  const ua = headerMap.get("user-agent") || null;
  const version = detectBinaryVersion() || ANTIGRAVITY_CLI_VERSION;
  const clMatch = /\bcl=(\d+)\b/.exec(ua || "");
  const endpoints = {};
  if (captured.loadCodeAssist) endpoints.loadCodeAssist = describeEndpoint(captured.loadCodeAssist);
  if (captured.streamGenerateContent) endpoints.streamGenerateContent = describeEndpoint(captured.streamGenerateContent);

  const snapshot = {
    version,
    cl: clMatch ? clMatch[1] : null,
    alpnProtocol: primary.alpnProtocol,
    uaTemplate: uaToTemplate(ua, { cl: clMatch?.[1], version }),
    headers: primary.parsed.headers.map(([name]) => name),
    capturedAt: new Date().toISOString(),
    capturedFrom: {
      host: primary.host,
      path: primary.parsed.path,
      httpVersion: primary.parsed.httpVersion,
      alpnProtocol: primary.alpnProtocol,
      endpoints,
    },
  };

  // The streaming call is the one place the wire could differ: a different
  // header set there would silently break every real turn.
  if (captured.streamGenerateContent) {
    const streamHeaders = endpoints.streamGenerateContent.headers;
    const differs = streamHeaders.length !== snapshot.headers.length
      || streamHeaders.some((name, index) => name !== snapshot.headers[index]);
    if (differs) {
      snapshot.streamHeaders = streamHeaders;
      dbg("AG_FP", `streamGenerateContent headers differ: ${streamHeaders.join(",")}`);
    }
  }
  return snapshot;
}

/** Capture when the binary moved. Never throws. */
export async function syncFingerprint({ force = false } = {}) {
  if (syncState.inflight) return syncState.inflight;
  const now = Date.now();
  if (!force) {
    if (now - syncState.lastAttemptAt < SYNC_MIN_INTERVAL_MS) return null;
    if (!needsRefresh()) return null;
  }
  syncState.lastAttemptAt = now;
  syncState.inflight = (async () => {
    try {
      const snapshot = await captureFingerprint();
      if (!snapshot) {
        dbg("AG_FP", "capture failed; keeping current fingerprint");
        return null;
      }
      const file = snapshotPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
      snapshotCache = { at: 0, mtimeMs: -1, data: null };
      console.log(`[Antigravity-FP] captured ${snapshot.version} cl=${snapshot.cl || "-"} headers=${snapshot.headers.join(",")}`);
      return snapshot;
    } catch (error) {
      dbg("AG_FP", `capture error: ${error.message}`);
      return null;
    } finally {
      syncState.inflight = null;
    }
  })();
  return syncState.inflight;
}

/** Arm background refresh once the engine actually serves requests. */
export function startFingerprintSync() {
  if (syncState.timer) return;
  if (process.env.NEXT_PHASE || process.env.ANTIGRAVITY_FINGERPRINT_CAPTURE === "0") return;
  const tick = () => { void updateBinary().then(() => syncFingerprint()).catch(() => {}); };
  syncState.startupTimer = setTimeout(tick, 5000);
  syncState.startupTimer.unref?.();
  syncState.timer = setInterval(tick, SYNC_INTERVAL_MS);
  syncState.timer.unref?.();
}

export function resetFingerprintCaches() {
  clearTimeout(syncState.startupTimer);
  clearInterval(syncState.timer);
  versionCache = { at: 0, version: null };
  snapshotCache = { at: 0, mtimeMs: -1, data: null };
  syncState = { inflight: null, lastAttemptAt: 0, timer: null, startupTimer: null };
  updateState = { inflight: null, lastAttemptAt: 0 };
}
