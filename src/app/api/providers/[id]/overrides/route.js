import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { buildUserAgent, getFingerprint } from "open-sse/services/antigravityFingerprint.js";

export const dynamic = "force-dynamic";

// Validation at the trust boundary — the UI also validates, but this is the gate.
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 8192;
// RFC 7230 token subset: letters, digits, hyphen (no spaces, no unicode)
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
// Request-structure / auth headers a user override must never touch
const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "authorization",
  "cookie",
]);

/**
 * Validate + normalize an override payload. Returns { override } or { error }.
 * An override with no headers is normalized to null (= delete).
 */
function normalizeOverride({ headers }, { canonical } = {}) {
  const out = {};
  // Antigravity sends exactly the six headers its native binary sends; allowing
  // an override would pin a stale User-Agent and add transport headers the
  // captured wire never contains. Clearing an existing override stays allowed.
  const fingerprintManaged = canonical === "antigravity";

  if (headers !== undefined && headers !== null) {
    if (typeof headers !== "object" || Array.isArray(headers)) {
      return { error: "headers must be an object" };
    }
    const entries = Object.entries(headers).filter(([, v]) => v !== "" && v != null);
    if (fingerprintManaged && entries.length > 0) {
      return { error: "Antigravity headers come from the installed agy binary and cannot be overridden" };
    }
    if (entries.length > MAX_HEADERS) {
      return { error: `Too many headers (max ${MAX_HEADERS})` };
    }
    const clean = {};
    for (const [name, value] of entries) {
      if (!HEADER_NAME_RE.test(name)) {
        return { error: `Invalid header name: ${name}` };
      }
      if (typeof value !== "string" || /[\r\n]/.test(value)) {
        return { error: `Invalid value for header ${name}` };
      }
      if (value.length > MAX_HEADER_VALUE_LENGTH) {
        return { error: `Header ${name} value too long (max ${MAX_HEADER_VALUE_LENGTH})` };
      }
      if (BLOCKED_HEADERS.has(name.toLowerCase())) {
        return { error: `Header ${name} cannot be overridden` };
      }
      clean[name] = value;
    }
    if (Object.keys(clean).length) out.headers = clean;
  }

  return { override: Object.keys(out).length ? out : null };
}

async function readOverrides() {
  const settings = await getSettings();
  return settings.providerOverrides || {};
}

/**
 * GET /api/providers/[id]/overrides — user override for this provider
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    // URL may use an alias (gcli, cc…) — key everything by canonical registry id
    const canonical = resolveProviderAlias(id);
    const override = (await readOverrides())[canonical] || {};
    // Built-in headers come from the registry transport, except Antigravity,
    // whose User-Agent is the live value captured from the installed binary.
    const builtinHeaders = canonical === "antigravity"
      ? { ...(PROVIDERS[canonical]?.headers || {}), "User-Agent": buildUserAgent(getFingerprint()) }
      : (PROVIDERS[canonical]?.headers || {});
    return NextResponse.json({
      headers: override.headers || {},
      builtinHeaders,
      fingerprintManaged: canonical === "antigravity",
    });
  } catch (error) {
    console.log("Error getting provider overrides:", error);
    return NextResponse.json({ error: "Failed to get overrides" }, { status: 500 });
  }
}

/**
 * PUT /api/providers/[id]/overrides — body: { headers: {name: value} }
 * Empty payload clears the override.
 */
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const canonical = resolveProviderAlias(id);
    const body = await request.json().catch(() => ({}));
    const { override, error } = normalizeOverride(body, { canonical });
    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }
    const current = await readOverrides();
    const next = { ...current };
    if (override) next[canonical] = override;
    else delete next[canonical];
    await updateSettings({ providerOverrides: next });
    return NextResponse.json({ headers: override?.headers || {} });
  } catch (error) {
    console.log("Error saving provider overrides:", error);
    return NextResponse.json({ error: "Failed to save overrides" }, { status: 500 });
  }
}
