/**
 * Antigravity header scrubbing.
 *
 * Real Antigravity is a Node.js app. Its outbound HTTP requests never carry
 * proxy tracing headers, Stainless SDK headers, or Chromium Sec-Ch-* headers.
 * Sending any of these reveals the request came through a third-party proxy.
 *
 * Ported from OmniRoute open-sse/services/antigravityHeaderScrub.ts.
 */

const HEADERS_TO_REMOVE = [
  // Proxy tracing
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
  "via",
  // Client identity (Stainless SDK — Claude Code specific, not Antigravity)
  "x-title",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
  "x-stainless-retry-count",
  "x-stainless-helper-method",
  "http-referer",
  "referer",
  // Browser / Chromium fingerprint (Electron clients, NOT Node.js)
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-dest",
  "priority",
  // Encoding: Antigravity (Node.js) sends "gzip, deflate, br" by default;
  // Electron clients add "zstd" which is a fingerprint mismatch.
  "accept-encoding",
];

/**
 * Remove headers that reveal proxy infrastructure or non-native client identity
 * from an outgoing request to Antigravity's upstream API.
 *
 * Authorization is deliberately emitted last: the native Antigravity client
 * serializes it as the final header before the body, and header order is part
 * of the fingerprint.
 */
export function scrubProxyAndFingerprintHeaders(headers) {
  const cleaned = {};
  let authorizationValue;
  for (const [key, value] of Object.entries(headers || {})) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith("x-9router-") || HEADERS_TO_REMOVE.includes(lowerKey)) {
      continue;
    }
    if (lowerKey === "authorization") {
      authorizationValue = value;
      continue;
    }
    cleaned[key] = value;
  }
  cleaned["Accept-Encoding"] = "gzip, deflate, br";
  if (authorizationValue !== undefined) {
    cleaned["Authorization"] = authorizationValue;
  }
  return cleaned;
}

export function removeHeaderCaseInsensitive(headers, name) {
  const lowerName = String(name).toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === lowerName) delete headers[key];
  }
}

/** Generic placeholder project ids Google treats as a bot signature. */
const GENERIC_PROJECT_IDS = new Set([
  "aicode-consumers",
  "test-project",
  "project-id",
]);

export function isGenericProjectId(value) {
  if (typeof value !== "string") return true;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" || GENERIC_PROJECT_IDS.has(trimmed);
}
