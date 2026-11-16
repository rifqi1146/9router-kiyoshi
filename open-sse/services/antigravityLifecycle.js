/**
 * Antigravity client lifecycle emulation.
 *
 * The real Antigravity CLI (`agy` 1.5.9, Go) is not a request-and-forget client.
 * Every session it performs a fixed preflight before it ever generates, and it
 * registers each trajectory before the turn that uses it. Verified by
 * TLS-intercepting the live binary on 2026-11-16 — exact wire bodies:
 *
 *   POST /v1internal:loadCodeAssist        {"metadata":{"ideType":"ANTIGRAVITY"}}
 *   POST /v1internal:fetchAdminControls    {"project":"aicode-consumers"}
 *   POST /v1internal:fetchUserInfo         {"project":"aicode-consumers"}
 *   POST /v1internal:fetchAvailableModels  {"project":"aicode-consumers"}
 *   POST /v1internal:retrieveUserQuotaSummary {"project":"aicode-consumers"}
 *   POST /v1internal:listExperiments       {"project":"aicode-consumers"}
 *   GET  aicode.googleapis.com/v1alpha:fetchConfig
 *   POST /v1internal:writeTrajectoryAcls   {"trajectoryId":"<uuid>"}
 *
 * A gateway that only ever POSTs streamGenerateContent is a client with no
 * history: no experiment config, no admin-control state, no trajectory it can
 * refer to. This module closes that gap.
 *
 * Everything here is fail-open: upstream errors, timeouts and aborts are
 * swallowed and never block or fail the user's request.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT } from "../providers/shared.js";
import { dbg } from "../utils/debugLog.js";

/** How often the per-account preflight runs. Mirrors the client's session start cadence. */
export const PREFLIGHT_TTL_MS = 10 * 60 * 1000;

/** How long a registered trajectory is remembered (dedupe only). */
export const TRAJECTORY_TTL_MS = 6 * 60 * 60 * 1000;

const PREFLIGHT_TIMEOUT_MS = 8_000;
const TRAJECTORY_TIMEOUT_MS = 4_000;

// Client-driven amplification guard: a caller can mint a new session id per
// request, which mints a new trajectory. Cap registration traffic per account
// so one API key cannot turn every turn into an extra upstream POST.
const MAX_TRAJECTORY_REGISTRATIONS_PER_MINUTE = 20;
const REGISTRATION_WINDOW_MS = 60_000;

const MAX_TRACKED_ACCOUNTS = 500;

const preflightAt = new Map();
const registeredTrajectories = new Map();
const registrationWindows = new Map();

function headersFor(accessToken) {
  return {
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    "Authorization": `Bearer ${accessToken}`,
  };
}

async function drain(response) {
  try {
    if (typeof response?.arrayBuffer === "function") await response.arrayBuffer();
    else if (typeof response?.text === "function") await response.text();
  } catch {
    /* body is irrelevant; a failed drain must not surface */
  }
}

async function postJson(endpoint, accessToken, payload, proxyOptions, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("antigravity lifecycle timeout")), timeoutMs);
  try {
    const response = await proxyAwareFetch(`${ANTIGRAVITY_IDE_BASE_URL}/v1internal:${endpoint}`, {
      method: "POST",
      headers: headersFor(accessToken),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }, proxyOptions);
    // Body is never needed; draining it lets the socket close cleanly.
    await drain(response);
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

async function getConfig(accessToken, proxyOptions, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("antigravity lifecycle timeout")), timeoutMs);
  try {
    const response = await proxyAwareFetch("https://aicode.googleapis.com/v1alpha:fetchConfig", {
      method: "GET",
      headers: headersFor(accessToken),
      signal: ctrl.signal,
    }, proxyOptions);
    await drain(response);
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_ACCOUNTS) {
    map.delete(map.keys().next().value);
  }
}

/**
 * Run the client's preflight once per account per PREFLIGHT_TTL_MS.
 * Never throws.
 *
 * @param {object} opts
 * @param {string} opts.connectionId
 * @param {string} opts.accessToken
 * @param {string} opts.projectId
 * @param {object} [opts.proxyOptions]
 * @param {object} [opts.log]
 */
export async function ensureAntigravitySession({ connectionId, accessToken, projectId, proxyOptions = null, log = null } = {}) {
  if (!connectionId || !accessToken || !projectId) return { skipped: true };

  const now = Date.now();
  const last = preflightAt.get(connectionId);
  if (last && now - last < PREFLIGHT_TTL_MS) return { skipped: true };

  // Arm before awaiting so concurrent turns cannot stampede the same account.
  remember(preflightAt, connectionId, now);

  const body = { project: projectId };
  const tasks = [
    ["listExperiments", postJson("listExperiments", accessToken, body, proxyOptions, PREFLIGHT_TIMEOUT_MS)],
    ["fetchAdminControls", postJson("fetchAdminControls", accessToken, body, proxyOptions, PREFLIGHT_TIMEOUT_MS)],
    ["fetchUserInfo", postJson("fetchUserInfo", accessToken, body, proxyOptions, PREFLIGHT_TIMEOUT_MS)],
    ["aicodeFetchConfig", getConfig(accessToken, proxyOptions, PREFLIGHT_TIMEOUT_MS)],
  ];

  const results = await Promise.allSettled(tasks.map(([, p]) => p));
  const statuses = {};
  results.forEach((r, i) => {
    statuses[tasks[i][0]] = r.status === "fulfilled" ? r.value : `error:${r.reason?.message || "unknown"}`;
  });
  dbg("AG_LIFECYCLE", `preflight ${connectionId.slice(0, 8)} ${JSON.stringify(statuses)}`);
  log?.debug?.("AG_LIFECYCLE", `preflight ${connectionId.slice(0, 8)} ${JSON.stringify(statuses)}`);
  return { ran: true, statuses };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Register a trajectory with upstream before the turn that references it.
 * The real client does this immediately before generating, once per trajectory.
 * Never throws.
 *
 * @param {object} opts
 * @param {string} opts.connectionId
 * @param {string} opts.accessToken
 * @param {string} opts.trajectoryId
 * @param {object} [opts.proxyOptions]
 * @param {object} [opts.log]
 */
export async function registerAntigravityTrajectory({ connectionId, accessToken, trajectoryId, proxyOptions = null, log = null } = {}) {
  if (!connectionId || !accessToken || !trajectoryId) return { skipped: true };
  if (!UUID_RE.test(trajectoryId)) return { skipped: true, reason: "not a uuid" };

  const key = `${connectionId}:${trajectoryId}`;
  const now = Date.now();
  const seen = registeredTrajectories.get(key);
  if (seen && now - seen < TRAJECTORY_TTL_MS) return { skipped: true, reason: "already registered" };

  const window = registrationWindows.get(connectionId);
  if (window && now - window.start < REGISTRATION_WINDOW_MS) {
    if (window.count >= MAX_TRAJECTORY_REGISTRATIONS_PER_MINUTE) {
      return { skipped: true, reason: "rate limited" };
    }
    window.count++;
  } else {
    remember(registrationWindows, connectionId, { start: now, count: 1 });
  }

  remember(registeredTrajectories, key, now);

  try {
    const status = await postJson("writeTrajectoryAcls", accessToken, { trajectoryId }, proxyOptions, TRAJECTORY_TIMEOUT_MS);
    dbg("AG_LIFECYCLE", `trajectory ${trajectoryId} registered (${status})`);
    log?.debug?.("AG_LIFECYCLE", `trajectory ${trajectoryId} registered (${status})`);
    return { ran: true, status };
  } catch (error) {
    // Fail-open: registration is an identity signal, not a correctness requirement.
    dbg("AG_LIFECYCLE", `trajectory ${trajectoryId} registration failed: ${error.message}`);
    return { ran: true, error: error.message };
  }
}

/** Test/debug helper. */
export function resetAntigravityLifecycle() {
  preflightAt.clear();
  registeredTrajectories.clear();
  registrationWindows.clear();
}
