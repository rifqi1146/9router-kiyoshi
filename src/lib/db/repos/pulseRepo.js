import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { getObservabilityConfig } from "@/lib/db/repos/requestDetailsRepo.js";

/**
 * Compute the p-th percentile from a pre-sorted numeric array.
 * Returns null if the array is empty.
 */
function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

/**
 * Initialize a blank aggregation accumulator.
 */
function createAccumulator(key) {
  return {
    key,
    total: 0,
    success: 0,
    error: 0,
    ttfts: [],
    totals: [],
    inTok: 0,
    outTok: 0,
    cachedTok: 0,
    lastSeen: null,
    statusCounts: {},
    httpStatusCounts: {},
  };
}

/**
 * Finalize an accumulator into a public stats row.
 */
function finalizeAccumulator(acc) {
  acc.ttfts.sort((a, b) => a - b);
  acc.totals.sort((a, b) => a - b);

  const successRate = acc.total > 0 ? acc.success / acc.total : 0;
  const errorRate = acc.total > 0 ? acc.error / acc.total : 0;
  const ttftP50 = percentile(acc.ttfts, 0.5);
  const ttftP95 = percentile(acc.ttfts, 0.95);
  const totalP50 = percentile(acc.totals, 0.5);
  const totalP95 = percentile(acc.totals, 0.95);

  const cacheHitRate = acc.inTok > 0 ? acc.cachedTok / acc.inTok : 0;

  // Health classification — success rate only, per Manuel.
  // ≥90% healthy · 70–<90% degraded · <70% down.
  // Latency is reported but never used to downgrade a provider; this router
  // regularly ships 100k–380k token prompts, so 6–8s TTFT is normal, not a fault.
  let health = "healthy";
  if (successRate < 0.7) {
    health = "down";
  } else if (successRate < 0.9) {
    health = "degraded";
  }

  return {
    key: acc.key,
    total: acc.total,
    success: acc.success,
    error: acc.error,
    successRate: +(successRate * 100).toFixed(1),
    errorRate: +(errorRate * 100).toFixed(1),
    ttftP50,
    ttftP95,
    totalP50,
    totalP95,
    inTok: acc.inTok,
    outTok: acc.outTok,
    cachedTok: acc.cachedTok,
    cacheHitRate: +(cacheHitRate * 100).toFixed(1),
    health,
    lastSeen: acc.lastSeen,
    statusCounts: acc.statusCounts,
    httpStatusCounts: acc.httpStatusCounts,
  };
}

/**
 * Fetch and aggregate provider health pulse from recent requestDetails.
 *
 * @param {Object} options
 * @param {number} [options.limit=200] - Sample window size (clamped 10..1000)
 * @returns {Promise<Object>} Aggregated pulse statistics
 */
export async function getProviderPulseStats({ limit = 200 } = {}) {
  const boundedLimit = Math.max(10, Math.min(1000, Number(limit) || 200));

  const obsConfig = await getObservabilityConfig();
  const observabilityEnabled = Boolean(obsConfig?.enabled);

  const db = await getAdapter();

  // LEFT JOIN providerConnections to resolve human-friendly account names/emails
  const rows = db.all(
    `SELECT r.id, r.provider, r.model, r.connectionId, r.timestamp, r.status, r.data,
            pc.name AS accountName, pc.email AS accountEmail
     FROM requestDetails r
     LEFT JOIN providerConnections pc ON r.connectionId = pc.id
     ORDER BY r.timestamp DESC
     LIMIT ?`,
    [boundedLimit]
  );

  const providerMap = {};
  const modelMap = {};
  const accountMap = {};
  const recentErrors = [];
  const globalHttpStatuses = {};

  let globalTotal = 0;
  let globalSuccess = 0;
  let globalError = 0;

  for (const r of rows) {
    const d = parseJson(r.data, {});
    const lat = d.latency || {};
    const tok = d.tokens || {};
    const resp = d.response || {};

    const ttft = typeof lat.ttft === "number" && lat.ttft > 0 ? lat.ttft : null;
    const tot = typeof lat.total === "number" && lat.total > 0 ? lat.total : null;
    const inTok = tok.prompt_tokens || 0;
    const outTok = tok.completion_tokens || 0;
    const cachedTok = tok.cached_tokens || tok.prompt_tokens_details?.cached_tokens || 0;

    const isOk = r.status === "success";
    // Only trust an explicitly stored numeric status. Some executors persist an
    // HTML/Next.js error body without a code; fabricating 500 here would be a lie.
    const httpStatus = typeof resp.status === "number"
      ? resp.status
      : (isOk ? 200 : null);
    const httpStatusKey = httpStatus === null ? "unknown" : String(httpStatus);

    globalTotal++;
    if (isOk) globalSuccess++; else globalError++;

    globalHttpStatuses[httpStatusKey] = (globalHttpStatuses[httpStatusKey] || 0) + 1;

    // Collect recent errors (up to 12) with HTTP code and message snippet
    if (!isOk && recentErrors.length < 12) {
      const rawErr = typeof resp.error === "string"
        ? resp.error
        : (typeof resp.content === "string" ? resp.content : "");
      const rawPreview = typeof resp._preview === "string" ? resp._preview : "";
      const combined = (rawErr || rawPreview || "").replace(/\s+/g, " ").trim();
      recentErrors.push({
        id: r.id,
        timestamp: r.timestamp,
        provider: r.provider || "unknown",
        model: r.model || "unknown",
        httpStatus,
        errorMessage: combined.slice(0, 160) || "Upstream request failed (no detail stored)",
        accountLabel: r.accountName || r.accountEmail || r.connectionId?.slice(0, 8) || "unknown",
      });
    }

    const providerKey = r.provider || "unknown";
    const modelKey = r.model || "unknown";
    const accountLabel = r.accountName || r.accountEmail || (r.connectionId ? `conn:${r.connectionId.slice(0, 8)}` : "default");
    const accountKey = `${providerKey} / ${accountLabel}`;

    const buckets = [
      [providerMap, providerKey],
      [modelMap, modelKey],
      [accountMap, accountKey],
    ];

    for (const [targetMap, key] of buckets) {
      targetMap[key] = targetMap[key] || createAccumulator(key);
      const acc = targetMap[key];
      acc.total++;
      if (isOk) acc.success++; else acc.error++;
      if (ttft) acc.ttfts.push(ttft);
      if (tot) acc.totals.push(tot);
      acc.inTok += inTok;
      acc.outTok += outTok;
      acc.cachedTok += cachedTok;
      if (!acc.lastSeen || r.timestamp > acc.lastSeen) acc.lastSeen = r.timestamp;
      acc.statusCounts[r.status] = (acc.statusCounts[r.status] || 0) + 1;
      acc.httpStatusCounts[httpStatusKey] = (acc.httpStatusCounts[httpStatusKey] || 0) + 1;
    }
  }

  const providers = Object.values(providerMap).map(finalizeAccumulator).sort((a, b) => b.total - a.total);
  const models = Object.values(modelMap).map(finalizeAccumulator).sort((a, b) => b.total - a.total);
  const accounts = Object.values(accountMap).map(finalizeAccumulator).sort((a, b) => b.total - a.total);

  const globalSuccessRate = globalTotal > 0 ? +((globalSuccess / globalTotal) * 100).toFixed(1) : 100;
  const globalErrorRate = globalTotal > 0 ? +((globalError / globalTotal) * 100).toFixed(1) : 0;

  // Overall gateway health follows the global success rate:
  // ≥90% healthy · 70–<90% degraded · <70% down.
  let overallHealth = "healthy";
  if (globalTotal === 0) {
    overallHealth = "unknown";
  } else if (globalSuccessRate < 70) {
    overallHealth = "down";
  } else if (globalSuccessRate < 90) {
    overallHealth = "degraded";
  }

  return {
    window: boundedLimit,
    timestamp: new Date().toISOString(),
    observabilityEnabled,
    summary: {
      totalRequests: globalTotal,
      successCount: globalSuccess,
      errorCount: globalError,
      successRate: globalSuccessRate,
      errorRate: globalErrorRate,
      overallHealth,
      activeProvidersCount: providers.length,
      activeModelsCount: models.length,
      activeAccountsCount: accounts.length,
      httpStatusDistribution: globalHttpStatuses,
    },
    providers,
    models,
    accounts,
    recentErrors,
  };
}
