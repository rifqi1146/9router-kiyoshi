/**
 * Antigravity header scrubbing.
 *
 * The real Antigravity client is the Go binary `agy` (1.5.9), not a Node/Electron
 * app — verified by TLS-intercepting the live CLI on 2026-11-16. Its outbound
 * Cloud Code requests carry exactly six headers:
 *
 *   accept-encoding: gzip
 *   authorization: Bearer …
 *   content-length: …
 *   content-type: application/json
 *   host: daily-cloudcode-pa.googleapis.com
 *   user-agent: antigravity/cli/1.5.9 (aidev_client; os_type=linux; …)
 *
 * No proxy tracing, no Stainless SDK headers, no Chromium Sec-Ch-*.
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
  // Encoding: the Go client lets net/http add `gzip` and nothing else. Node's
  // default `gzip, deflate, br` is a giveaway that the request did not come
  // from the native binary.
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
  cleaned["Accept-Encoding"] = "gzip";
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

// Single source of truth: projectId.js owns the placeholder set, so the executor,
// the translator and the chat core cannot disagree about what counts as "no project".
export { isPlaceholderProjectId as isGenericProjectId } from "./projectId.js";
