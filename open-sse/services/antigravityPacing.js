/**
 * Per-account request pacing for Antigravity.
 *
 * Stock 9router round-robins every request across accounts with no spacing.
 * Google sees one conversation arriving from four different identities within
 * seconds — a pattern no human client produces, and the cheapest signal to
 * correlate accounts on.
 *
 * This module enforces a minimum gap between requests to the SAME account and
 * adds jitter so bursts spread out. Accounts that are still cooling are skipped
 * and the next candidate is used, exactly like a model lock.
 *
 * Ported from the pacing intent in OmniRoute's account rotation layer.
 */

/** Minimum spacing between two requests on one account (ms). */
export const MIN_ACCOUNT_INTERVAL_MS = 1200;

/** Jitter fraction applied on top of the interval (±30%). */
const JITTER = 0.3;

/** connectionId -> last request timestamp */
const lastRequestAt = new Map();

/** connectionId -> earliest allowed next request timestamp */
const nextAllowedAt = new Map();

function jitteredInterval() {
  const spread = MIN_ACCOUNT_INTERVAL_MS * JITTER;
  return Math.round(MIN_ACCOUNT_INTERVAL_MS + (Math.random() * 2 - 1) * spread);
}

/**
 * True when this account is allowed to serve a request right now.
 * @param {string} connectionId
 * @param {number} now
 */
export function isAccountPaced(connectionId, now = Date.now()) {
  if (!connectionId) return true;
  const next = nextAllowedAt.get(connectionId);
  return !next || next <= now;
}

/**
 * Mark that a request just started on this account, arming the next interval.
 * @param {string} connectionId
 * @param {number} now
 */
export function markAccountRequest(connectionId, now = Date.now()) {
  if (!connectionId) return;
  lastRequestAt.set(connectionId, now);
  nextAllowedAt.set(connectionId, now + jitteredInterval());
}

/**
 * Remaining wait for this account, 0 when ready.
 */
export function getAccountPacingWait(connectionId, now = Date.now()) {
  if (!connectionId) return 0;
  const next = nextAllowedAt.get(connectionId);
  if (!next || next <= now) return 0;
  return next - now;
}

/** Test/debug helper. */
export function resetAccountPacing() {
  lastRequestAt.clear();
  nextAllowedAt.clear();
}
