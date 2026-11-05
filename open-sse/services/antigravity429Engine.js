/**
 * Antigravity 429 classification + retry decision engine.
 *
 * 9router treats every 429 identically: exponential backoff capped at 5 minutes.
 * That is wrong for Antigravity, where a 429 means one of four very different things.
 * Retrying a 24-hour quota exhaustion every 5 minutes is what gets accounts banned.
 *
 * Categories:
 *   - soft_rate_limit:  temporary burst limit   → instant retry on same auth
 *   - rate_limited:     per-minute (RPM) limit  → short backoff, same auth
 *   - quota_exhausted:  daily/plan quota gone   → switch auth or 24h cooldown
 *   - unknown:          generic                 → exponential backoff
 *
 * Ported from OmniRoute open-sse/services/antigravity429Engine.ts.
 */

const QUOTA_EXHAUSTED_KEYWORDS = [
  "quota_exhausted",
  "quota exhausted",
  // Antigravity native: "Individual quota reached. Contact your administrator to enable overages."
  "quota reached",
  "enable overages",
  "individual quota",
];

const CREDITS_EXHAUSTED_KEYWORDS = [
  "google_one_ai",
  "insufficient credit",
  "insufficient credits",
  "not enough credit",
  "not enough credits",
  "credit exhausted",
  "credits exhausted",
  "credit balance",
  "minimumcreditamountforusage",
  "minimum credit amount for usage",
  "minimum credit",
  "insufficient_g1_credits_balance",
  "g1_credits",
];

export const SHORT_COOLDOWN_MS = 5 * 60 * 1000;          // 5 minutes
export const INSTANT_RETRY_THRESHOLD_MS = 3 * 1000;      // 3 seconds
export const FULL_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Classify a 429 body into one of the four categories.
 * @param {string} errorMessage
 * @returns {"unknown"|"rate_limited"|"quota_exhausted"|"soft_rate_limit"}
 */
export function classify429(errorMessage) {
  const lower = String(errorMessage || "").toLowerCase();

  // Cloud Code may report an exhausted-capacity message with a zero reset
  // window for a burst/RPM throttle. The explicit zero reset is stronger
  // evidence than the generic wording, so retry briefly instead of applying
  // the durable quota cooldown.
  if (/\breset\s+(?:after|in)\s+0s\b/.test(lower)) {
    return "rate_limited";
  }

  // Most specific first: quota exhaustion.
  for (const kw of QUOTA_EXHAUSTED_KEYWORDS) {
    if (lower.includes(kw)) return "quota_exhausted";
  }
  for (const kw of CREDITS_EXHAUSTED_KEYWORDS) {
    if (lower.includes(kw)) return "quota_exhausted";
  }

  // RPM / rate limit.
  if (
    lower.includes("per minute") ||
    lower.includes("rpm") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests")
  ) {
    return "rate_limited";
  }

  // Free tier / daily exhaustion.
  if (
    lower.includes("free tier") ||
    lower.includes("daily limit") ||
    lower.includes("exhausted your capacity")
  ) {
    return "quota_exhausted";
  }

  // Soft / burst.
  if (lower.includes("try again") || lower.includes("temporarily")) {
    return "soft_rate_limit";
  }

  return "unknown";
}

/**
 * Decide what to do with a 429 given its category and the upstream retry hint.
 * @returns {{kind: string, retryAfterMs: number|null, reason: string}}
 */
export function decide429(category, retryAfterMs) {
  switch (category) {
    case "soft_rate_limit":
      return {
        kind:
          retryAfterMs && retryAfterMs <= INSTANT_RETRY_THRESHOLD_MS
            ? "instant_retry_same_auth"
            : "soft_retry",
        retryAfterMs: retryAfterMs ?? 2000,
        reason: "Soft rate limit — brief backoff",
      };

    case "rate_limited":
      return {
        kind:
          retryAfterMs && retryAfterMs <= SHORT_COOLDOWN_MS
            ? "soft_retry"
            : "short_cooldown_switch_auth",
        retryAfterMs: retryAfterMs ?? SHORT_COOLDOWN_MS,
        reason: "RPM rate limit — short cooldown then switch account",
      };

    case "quota_exhausted":
      return {
        kind: "full_quota_exhausted",
        retryAfterMs: retryAfterMs ?? FULL_QUOTA_COOLDOWN_MS,
        reason: "Quota exhausted — 24h cooldown, skip this account",
      };

    default:
      return {
        kind: "soft_retry",
        retryAfterMs: retryAfterMs ?? SHORT_COOLDOWN_MS,
        reason: "Unknown 429 — exponential backoff",
      };
  }
}

/**
 * Convenience wrapper: classify then decide.
 */
export function analyze429(errorMessage, retryAfterMs = null) {
  const category = classify429(errorMessage);
  return { category, ...decide429(category, retryAfterMs) };
}

/** True when the cooldown should be treated as durable (skip account, not retry). */
export function isDurable429(decision) {
  return decision?.kind === "full_quota_exhausted";
}
