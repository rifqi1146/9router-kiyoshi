import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

const VALID_RESET_PERIODS = new Set(["total", "daily"]);

function normalizeTokenLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function normalizeResetPeriod(value) {
  const v = String(value || "total").toLowerCase();
  return VALID_RESET_PERIODS.has(v) ? v : "total";
}

/**
 * Normalize an expiration input into an ISO string or null.
 * Accepts an ISO string, a Date, a positive number of milliseconds from now,
 * or a duration string such as "1d", "2d", "7d", "30d", "12h".
 * Anything unparseable or non-positive becomes null (unlimited).
 */
function normalizeExpiresAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(Date.now() + value).toISOString();
  }
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d+)\s*(m|h|d|w)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
      if (!n || !ms) return null;
      return new Date(Date.now() + n * ms).toISOString();
    }
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return Date.now() >= t;
}

function normalizeInjection(value) {
  // Legacy rows created before the column existed read as NULL. Those keys
  // behaved as "injection on", so NULL must stay on.
  if (value === null || value === undefined || value === "") return true;
  if (value === false) return false;
  // Some drivers hand back the value as text ("0", "0.0"). Compare numerically
  // so a disabled key is never mistaken for an enabled one.
  const n = Number(value);
  return !(Number.isFinite(n) && n === 0);
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
    tokenLimit: normalizeTokenLimit(row.tokenLimit),
    tokenResetPeriod: normalizeResetPeriod(row.tokenResetPeriod),
    expiresAt: row.expiresAt || null,
    expired: isExpired(row.expiresAt),
    injection: normalizeInjection(row.injection),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

/**
 * Token usage for one key. Computed from usageHistory so no counter can drift.
 * @returns {Promise<{totalTokens:number,dailyTokens:number,requests:number,lastUsed:string|null}>}
 */
export async function getKeyUsage(key) {
  const empty = { totalTokens: 0, dailyTokens: 0, requests: 0, lastUsed: null };
  if (!key) return empty;
  const db = await getAdapter();
  const lifetime = db.get(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(promptTokens + completionTokens), 0) AS totalTokens,
            MAX(timestamp) AS lastUsed
       FROM usageHistory
      WHERE apiKey = ?`,
    [key]
  ) || {};
  const today = db.get(
    `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS dailyTokens
       FROM usageHistory
      WHERE apiKey = ?
        AND timestamp >= date('now', 'start of day')`,
    [key]
  ) || {};
  return {
    totalTokens: Number(lifetime.totalTokens) || 0,
    dailyTokens: Number(today.dailyTokens) || 0,
    requests: Number(lifetime.requests) || 0,
    lastUsed: lifetime.lastUsed || null,
  };
}

/** Usage for every key at once, keyed by the raw key string. */
export async function getAllKeyUsage() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT apiKey,
            COUNT(*) AS requests,
            COALESCE(SUM(promptTokens + completionTokens), 0) AS totalTokens,
            MAX(timestamp) AS lastUsed
       FROM usageHistory
      WHERE apiKey IS NOT NULL AND apiKey != ''
      GROUP BY apiKey`
  ) || [];
  const dailyRows = db.all(
    `SELECT apiKey,
            COALESCE(SUM(promptTokens + completionTokens), 0) AS dailyTokens
       FROM usageHistory
      WHERE apiKey IS NOT NULL AND apiKey != ''
        AND timestamp >= date('now', 'start of day')
      GROUP BY apiKey`
  ) || [];

  const map = {};
  for (const r of rows) {
    map[r.apiKey] = {
      totalTokens: Number(r.totalTokens) || 0,
      dailyTokens: 0,
      requests: Number(r.requests) || 0,
      lastUsed: r.lastUsed || null,
    };
  }
  for (const r of dailyRows) {
    if (!map[r.apiKey]) {
      map[r.apiKey] = { totalTokens: 0, dailyTokens: 0, requests: 0, lastUsed: null };
    }
    map[r.apiKey].dailyTokens = Number(r.dailyTokens) || 0;
  }
  return map;
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const access = options.access || KEY_ACCESS_UNRESTRICTED;
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access,
    tokenLimit: normalizeTokenLimit(options.tokenLimit),
    tokenResetPeriod: normalizeResetPeriod(options.tokenResetPeriod),
    expiresAt: normalizeExpiresAt(options.expiresAt),
    injection: options.injection === false ? false : true,
  };
  const cols = keyAccessToColumns(access);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow, tokenLimit, tokenResetPeriod, expiresAt, injection)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id,
      apiKey.key,
      apiKey.name,
      apiKey.machineId,
      1,
      apiKey.createdAt,
      cols.accessRestricted,
      cols.accessAllow,
      apiKey.tokenLimit,
      apiKey.tokenResetPeriod,
      apiKey.expiresAt,
      apiKey.injection ? 1 : 0,
    ]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    const expiresAt = data.expiresAt !== undefined ? normalizeExpiresAt(data.expiresAt) : row.expiresAt;
    db.run(
      `UPDATE apiKeys
          SET key = ?, name = ?, machineId = ?, isActive = ?,
              accessRestricted = ?, accessAllow = ?,
              tokenLimit = ?, tokenResetPeriod = ?,
              expiresAt = ?, injection = ?
        WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        cols.accessRestricted,
        cols.accessAllow,
        normalizeTokenLimit(merged.tokenLimit),
        normalizeResetPeriod(merged.tokenResetPeriod),
        expiresAt,
        merged.injection === false ? 0 : 1,
        id,
      ]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive, expiresAt FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  if (row.isActive !== 1 && row.isActive !== true) return false;
  if (isExpired(row.expiresAt)) return false;
  return true;
}

export { normalizeTokenLimit, normalizeResetPeriod, normalizeExpiresAt, isExpired };
