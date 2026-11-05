/**
 * Antigravity Family Cooldown — isolate quota lockout per model family.
 *
 * Antigravity quota is divided into three distinct families upstream:
 *   - gemini (flash, pro, image)
 *   - claude (sonnet, opus)
 *   - argon  (gemini-4-argon variants)
 *
 * When an account runs out of Gemini quota, Cloud Code only locks Gemini models.
 * The account remains fully capable of serving Claude and Argon.
 *
 * In stock 9router, one 429 locks the entire connection or applies a broad
 * cache block. This module classifies model names to families and records
 * family-level rate limits so sibling families keep serving instantly.
 *
 * Ported from OmniRoute open-sse/services/antigravityFamilyCooldown.ts.
 */

/**
 * Classify a model name into an Antigravity family.
 * @param {string} model
 * @returns {"gemini"|"claude"|"argon"|"other"}
 */
export function getAntigravityQuotaFamily(model) {
  if (typeof model !== "string" || !model.trim()) return "other";
  const lower = (model.includes("/") ? model.slice(model.indexOf("/") + 1) : model).toLowerCase();

  if (lower.includes("argon") || lower.startsWith("4-argon")) {
    return "argon";
  }
  if (lower.startsWith("claude-") || lower === "claude") {
    return "claude";
  }
  if (lower.startsWith("gemini-") || lower === "gemini") {
    return "gemini";
  }
  return "other";
}

/** Models belonging to each family (for broad locking). */
const FAMILY_MEMBERS = {
  argon: [
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-4-argon-low",
    "gemini-4-argon",
    "4-argon",
  ],
  claude: [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-opus-4-5",
  ],
  gemini: [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.8-flash",
    "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low",
    "gemini-3.7-flash",
    "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
  ],
};

/**
 * Expand a model lock to all members of its family.
 * Returns an array of model names to lock together.
 * @param {string} model
 * @returns {string[]}
 */
export function getFamilyLockCandidates(model) {
  const family = getAntigravityQuotaFamily(model);
  if (family === "other" || !FAMILY_MEMBERS[family]) {
    return [model];
  }
  return FAMILY_MEMBERS[family];
}

/**
 * Check whether a family is currently blocked on a connection row.
 * Reads the `antigravityFamilyRateLimitedUntil` map from providerSpecificData.
 * @param {object} connection
 * @param {string} model
 * @returns {boolean}
 */
export function isFamilyLocked(connection, model) {
  if (!connection) return false;
  const family = getAntigravityQuotaFamily(model);
  if (family === "other") return false;

  let psd = connection.providerSpecificData;
  if (typeof psd === "string") {
    try { psd = JSON.parse(psd); } catch { return false; }
  }
  if (!psd || typeof psd !== "object") return false;

  const familyLocks = psd.antigravityFamilyRateLimitedUntil;
  if (!familyLocks || typeof familyLocks !== "object") return false;

  const untilStr = familyLocks[family];
  if (!untilStr) return false;

  const until = new Date(untilStr).getTime();
  return Number.isFinite(until) && until > Date.now();
}
