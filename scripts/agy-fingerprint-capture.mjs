#!/usr/bin/env node
/**
 * Capture the installed `agy` client fingerprint into DATA_DIR.
 *
 *   node scripts/agy-fingerprint-capture.mjs           # capture now
 *   node scripts/agy-fingerprint-capture.mjs --check   # exit 1 if stale
 *   node scripts/agy-fingerprint-capture.mjs --print   # capture, print, no write
 *
 * Offline by construction: the probe runs `agy -p` with a throwaway profile
 * holding a dummy token behind a local CONNECT recorder, so no Google account is
 * involved and nothing leaves the machine. See
 * open-sse/services/antigravityFingerprint.js.
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildUserAgent,
  captureFingerprint,
  detectBinaryVersion,
  getFingerprint,
  needsRefresh,
  snapshotPath,
} from "../open-sse/services/antigravityFingerprint.js";

const args = new Set(process.argv.slice(2));

function report() {
  const fp = getFingerprint();
  console.log(`binary      : ${detectBinaryVersion() || "(not found)"}`);
  console.log(`snapshot    : ${fp.version} (${fp.source}${fp.capturedAt ? `, ${fp.capturedAt}` : ""})`);
  console.log(`cl          : ${fp.cl || "-"}`);
  console.log(`alpn        : ${fp.alpnProtocol || "http/1.1"}`);
  console.log(`headers     : ${fp.headers.join(", ")}`);
  console.log(`user-agent  : ${buildUserAgent(fp) || "-"}`);
  console.log(`last checked: ${fp.lastCheckedAt || "-"}`);
  console.log(`stale       : ${needsRefresh() ? "yes" : "no"}`);
  console.log(`snapshot at : ${snapshotPath()}`);
}

if (args.has("--check")) {
  report();
  process.exit(needsRefresh() ? 1 : 0);
}

if (args.has("--print")) {
  const snapshot = await captureFingerprint();
  if (!snapshot) {
    console.error("capture failed: binary missing, no MITM CA, or the probe never reached the recorder");
    process.exit(1);
  }
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

const snapshot = await captureFingerprint();
if (!snapshot) {
  console.error("capture failed: binary missing, no MITM CA, or the probe never reached the recorder");
  process.exit(1);
}
const file = snapshotPath();
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
report();
