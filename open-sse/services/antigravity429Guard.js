/**
 * Antigravity 429 Guard — stop hammering Google when an exact request is refused.
 *
 * Cloud Code answers some requests with `429 Resource has been exhausted`
 * because Google refuses the request content itself (e.g. system prompt identity
 * lines), NOT because the account ran out of quota.
 *
 * Without this guard: 1 prompt → retried across hosts × retried by chat core ×
 * retried by caller client SDK = ~45 upstream refused requests in 20 minutes.
 * That is the exact burst pattern that triggers Google's automated account flag.
 *
 * This guard hashes (model + systemInstruction + contents). When a request is
 * refused, identical repeats are answered locally with a synthetic 429 for
 * REFUSAL_BLOCK_BASE_MS (starts at 2m, doubles up to 30m). Zero upstream calls.
 *
 * Ported from OmniRoute open-sse/services/antigravity429Guard.ts.
 */

import { createHash } from "node:crypto";

export const REFUSAL_BLOCK_BASE_MS = 2 * 60 * 1000;
export const REFUSAL_BLOCK_MAX_MS = 30 * 60 * 1000;
const REFUSAL_STRIKE_WINDOW_MS = 60 * 60 * 1000;
const REFUSAL_MEMORY_MAX_ENTRIES = 500;

export const ANTIGRAVITY_REFUSAL_REPLAY_MARKER =
  "9Router is not resending it to Antigravity";

const refusals = new Map();

function pruneRefusals(now) {
  for (const [k, v] of refusals.entries()) {
    if (v.blockedUntil <= now) refusals.delete(k);
  }
  while (refusals.size > REFUSAL_MEMORY_MAX_ENTRIES) {
    const oldest = refusals.keys().next().value;
    if (oldest !== undefined) refusals.delete(oldest);
  }
}

/**
 * Stable key for "same request content to same account": connection + model + body content.
 * Ephemeral ids (requestId, sessionId, project) are excluded so caller SDK retries map
 * to the exact same key.
 */
export function fingerprintAntigravityRequest(connectionId, envelope) {
  const request =
    envelope && typeof envelope === "object" && envelope.request && typeof envelope.request === "object"
      ? envelope.request
      : {};
  const material = JSON.stringify([
    connectionId || "default",
    envelope?.model ?? null,
    request.systemInstruction ?? null,
    request.contents ?? null,
    request.tools ?? null,
    request.toolConfig ?? null,
    request.generationConfig?.temperature ?? null,
    request.generationConfig?.topP ?? null,
    request.generationConfig?.topK ?? null,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Record a 429 response for `key`.
 * If `upstreamHintMs` is provided (from Retry-After header), uses that.
 * Otherwise applies exponential backoff: 2m, 4m, 8m... up to 30m.
 */
export function rememberAntigravity429Refusal(key, upstreamHintMs, now = Date.now()) {
  const previous = refusals.get(key);
  const strikes =
    previous && previous.blockedUntil + REFUSAL_STRIKE_WINDOW_MS >= now
      ? previous.strikes + 1
      : 1;
  const blockMs =
    typeof upstreamHintMs === "number" && Number.isFinite(upstreamHintMs) && upstreamHintMs > 0
      ? Math.min(upstreamHintMs, REFUSAL_BLOCK_MAX_MS)
      : Math.min(REFUSAL_BLOCK_BASE_MS * 2 ** (strikes - 1), REFUSAL_BLOCK_MAX_MS);

  refusals.delete(key);
  refusals.set(key, { blockedUntil: now + blockMs, strikes });
  pruneRefusals(now);
  return { blockMs, strikes };
}

/** Returns the active block for `key`, or null if the request may go upstream. */
export function getActiveAntigravityRefusal(key, now = Date.now()) {
  const entry = refusals.get(key);
  if (!entry || entry.blockedUntil <= now) return null;
  return { remainingMs: entry.blockedUntil - now, strikes: entry.strikes };
}

/** Synthesize a local 429 response without hitting Google upstream. */
export function buildAntigravityRefusalReplayResponse(refusal) {
  const seconds = Math.max(1, Math.ceil(refusal.remainingMs / 1000));
  const message =
    `Antigravity refused this exact request with 429 RESOURCE_EXHAUSTED and ${ANTIGRAVITY_REFUSAL_REPLAY_MARKER} ` +
    `for another ${seconds}s (repeat ${refusal.strikes}), to avoid hammering the upstream. If the ` +
    `account still has quota, the upstream is refusing the request content itself; change the prompt or switch provider.`;
  return {
    status: 429,
    statusText: "Too Many Requests",
    headers: new Headers({
      "Content-Type": "application/json",
      "Retry-After": String(seconds),
    }),
    body: JSON.stringify({
      error: { code: 429, message, status: "RESOURCE_EXHAUSTED" },
    }),
  };
}

export function isAntigravityRefusalReplay(status, errorMessage) {
  return (
    Number(status) === 429 &&
    typeof errorMessage === "string" &&
    errorMessage.includes(ANTIGRAVITY_REFUSAL_REPLAY_MARKER)
  );
}
