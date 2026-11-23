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
 *      credentials — the recorder answers every request itself.
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
import tls from "node:tls";
import { spawn, execFile, execFileSync } from "node:child_process";
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

/** Captured 2026-11-23 from agy 1.5.14, `/v1internal:loadCodeAssist`. */
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
  if (versionCache.version && now - versionCache.at < VERSION_CACHE_MS) return versionCache.version;
  const bin = binaryPath();
  if (!fs.existsSync(bin)) return null;
  try {
    const out = execFileSync(bin, ["--version"], { timeout: 4000, encoding: "utf8" });
    const line = String(out || "").split("\n").map((l) => l.trim()).find((l) => VERSION_RE.test(l));
    if (line) {
      versionCache = { at: now, version: line };
      return line;
    }
  } catch { /* binary refused or timed out */ }
  return null;
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
  const template = fp?.uaTemplate;
  if (!template) return fp?.ua || ANTIGRAVITY_IDE_USER_AGENT;
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
  return {
    ...base,
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
  updateState.inflight = new Promise((resolve) => {
    execFile(bin, ["update"], { timeout: timeoutMs, killSignal: "SIGKILL" }, (error) => {
      updateState.inflight = null;
      if (error) {
        dbg("AG_FP", `agy update failed: ${error.message}`);
        return resolve(false);
      }
      versionCache = { at: 0, version: null };
      resolve(true);
    });
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
  if (!ua) return null;
  let out = ua
    .replaceAll("host_path=", "host_path=") // ACP clients add this; drop the whole param.
    .replace(/;\s*host_path=[^;)]*/g, "")
    .replace(/\s*\(([^)]*?)\s*\)\s*$/, (m, inner) => ` (${inner.replace(/\s*;\s*host_path=[^;)]*/g, "")})`);
  if (version) out = out.replaceAll(version, "{version}");
  if (cl) out = out.replaceAll(`cl=${cl}`, "cl={cl}");
  out = out.replace(/os_type=[a-z0-9]+/i, "os_type={os}").replace(/arch=[a-z0-9_]+/i, "arch={arch}");
  return out.replace(/\(\s*;\s*/g, "(").replace(/;\s*\)/g, ")");
}

const MIRRORED_HOSTS = new Set([
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "aicode.googleapis.com",
]);

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

/** Minimal localhost CONNECT recorder that answers every mirrored request itself. */
function startRecorder({ cert, onRequest }) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on("connect", (req, clientSocket) => {
    const host = String(req.url || "").split(":")[0];
    if (!MIRRORED_HOSTS.has(host)) { clientSocket.destroy(); return; }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let leaf;
    try { leaf = cert.getCertForDomain(host); } catch { leaf = null; }
    if (!leaf) { clientSocket.destroy(); return; }
    const socket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: tls.createSecureContext({ key: leaf.key, cert: leaf.cert }),
      ALPNProtocols: ["http/1.1"],
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      // The native Cloud Code client is HTTP/1.1: head then body by content-length.
      const split = buf.indexOf("\r\n\r\n");
      if (split < 0) return;
      const head = buf.slice(0, split);
      const parsed = parseCapturedRequest(head);
      const length = Number((parsed?.headers || []).find(([n]) => n === "content-length")?.[1] || 0);
      if (buf.length - (split + 4) < length) return; // wait for the body
      const body = Buffer.from(buf.slice(split + 4, split + 4 + length), "latin1");
      if (onRequest) onRequest({ host, parsed, body });
      try {
        socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 27\r\n\r\n{\"error\":{\"code\":401,\"m\":1}}");
      } catch { /* client gone */ }
    });
    socket.on("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
  });
  return server;
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

  let captured = null;
  const server = startRecorder({
    cert,
    onRequest: ({ host, parsed, body }) => { if (!captured) captured = { host, parsed, body }; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fp-"));
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

  const child = spawn(bin, ["-p", "fp-probe"], {
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

  const deadline = Date.now() + timeoutMs;
  try {
    while (!captured && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    server.close();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!captured) return null;

  const headerMap = new Map(captured.parsed.headers);
  const ua = headerMap.get("user-agent") || null;
  const version = detectBinaryVersion() || ANTIGRAVITY_CLI_VERSION;
  const clMatch = /\bcl=(\d+)\b/.exec(ua || "");

  return {
    version,
    cl: clMatch ? clMatch[1] : null,
    uaTemplate: uaToTemplate(ua, { cl: clMatch?.[1], version }),
    headers: captured.parsed.headers.map(([name]) => name),
    capturedAt: new Date().toISOString(),
    capturedFrom: {
      host: captured.host,
      path: captured.parsed.path,
      httpVersion: captured.parsed.httpVersion,
    },
  };
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
