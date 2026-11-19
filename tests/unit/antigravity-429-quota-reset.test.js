/**
 * Regression: a per-model Cloud Code 429 carries its real reset in the body
 * (details[].metadata.quotaResetTimeStamp / RetryInfo.retryDelay), never in a
 * header.
 *
 * Before the fix:
 *   - imageGeneration.js dropped result.resetsAtMs, so markAccountUnavailable
 *     fell through to checkFallbackError(), which matches the "capacity"
 *     keyword and applies the generic 429 backoff: ~4s on the first strike.
 *   - A model exhausted for 4h was therefore retried thousands of times inside
 *     its own reset window.
 *   - computeRetryDelay() fed null into analyze429(), so a durable quota was
 *     treated as the 24h plan default instead of the 4h Google reported.
 */
import { describe, expect, it } from "vitest";
import {
  analyze429,
  isDurable429,
  parseQuotaResetMsFromError,
} from "../../open-sse/services/antigravity429Engine.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const REAL_429_BODY = `{
  "error": {
    "code": 429,
    "message": "You have exhausted your capacity on this model. Your quota will reset after 4h3m9s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "uiMessage": "true",
          "model": "gemini-3.1-flash-image",
          "quotaResetDelay": "4h3m9.932911578s",
          "quotaResetTimeStamp": "2026-11-19T15:45:11Z"
        }
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "14589.932911578s"
      }
    ]
  }
}`;

const ROUTER_PREFIXED_ERROR = `[429]: ${REAL_429_BODY}`;

describe("parseQuotaResetMsFromError", () => {
  it("prefers the absolute quotaResetTimeStamp over derived delays", () => {
    const now = Date.parse("2026-11-19T11:41:00Z");
    const ms = parseQuotaResetMsFromError(REAL_429_BODY, now);
    // 15:45:11Z - 11:41:00Z = 4h4m11s
    expect(ms).toBe(4 * 3600_000 + 4 * 60_000 + 11_000);
  });

  it("parses the router's [429]: prefix wrapping the JSON body", () => {
    const now = Date.parse("2026-11-19T11:41:00Z");
    expect(parseQuotaResetMsFromError(ROUTER_PREFIXED_ERROR, now))
      .toBe(4 * 3600_000 + 4 * 60_000 + 11_000);
  });

  it("falls back to RetryInfo.retryDelay when no timestamp is present", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "14589.93s" }],
      },
    });
    expect(parseQuotaResetMsFromError(body, Date.now())).toBe(14_589_930);
  });

  it("falls back to the human message when details are absent", () => {
    const text = "429: You have exhausted your capacity on this model. Your quota will reset after 4h3m9s.";
    expect(parseQuotaResetMsFromError(text, Date.now())).toBe(
      (4 * 3600 + 3 * 60 + 9) * 1000,
    );
  });

  it("returns null for a reset timestamp that has already passed", () => {
    const body = JSON.stringify({
      error: { details: [{ metadata: { quotaResetTimeStamp: "2026-11-19T10:00:00Z" } }] },
    });
    expect(parseQuotaResetMsFromError(body, Date.parse("2026-11-19T11:41:00Z"))).toBeNull();
  });

  it("returns null for an unrelated provider error", () => {
    expect(parseQuotaResetMsFromError("502 bad gateway", Date.now())).toBeNull();
    expect(parseQuotaResetMsFromError(null, Date.now())).toBeNull();
    expect(parseQuotaResetMsFromError(new Error("boom"), Date.now())).toBeNull();
  });
});

describe("durable quota uses the upstream reset instead of the 24h plan default", () => {
  it("returns the real 4h4m cooldown, not 24h", () => {
    const now = Date.parse("2026-11-19T11:41:00Z");
    const retryMs = parseQuotaResetMsFromError(REAL_429_BODY, now);
    const decision = analyze429(REAL_429_BODY, retryMs);

    expect(decision.category).toBe("quota_exhausted");
    expect(isDurable429(decision)).toBe(true);
    expect(decision.retryAfterMs).toBe(4 * 3600_000 + 4 * 60_000 + 11_000);
    expect(decision.retryAfterMs).toBeLessThan(24 * 3600_000);
  });

  it("still applies the 24h default when the body carries no reset at all", () => {
    const decision = analyze429("QUOTA_EXHAUSTED", parseQuotaResetMsFromError("QUOTA_EXHAUSTED"));
    expect(decision.retryAfterMs).toBe(24 * 3600_000);
  });
});

describe("the legacy 429 backoff is what made the dead model reachable", () => {
  it("would have locked for seconds while Google said hours", () => {
    const legacy = checkFallbackError(429, REAL_429_BODY, 0, "antigravity");
    expect(legacy.shouldFallback).toBe(true);
    // The generic 429 backoff: 4s base. This is the value the image path used
    // before it started forwarding resetsAtMs to markAccountUnavailable().
    expect(legacy.cooldownMs).toBeLessThan(60_000);
  });
});
