import { NextResponse } from "next/server";
import { buildUserAgent, getFingerprint, needsRefresh, refreshFingerprint, syncFingerprint } from "open-sse/services/antigravityFingerprint.js";
import { getWireBackendInfo } from "open-sse/utils/antigravityWire.js";

export const dynamic = "force-dynamic";

function readTlsBackend() {
  try {
    const info = getWireBackendInfo();
    return {
      backend: info?.backend || "node-openssl",
      active: Boolean(info?.active),
    };
  } catch {
    return { backend: "node-openssl", active: false };
  }
}

function serialize(fp, stale) {
  return {
    source: fp.source,
    version: fp.version,
    liveVersion: fp.liveVersion,
    cl: fp.cl,
    alpnProtocol: fp.alpnProtocol || "http/1.1",
    tlsBackend: readTlsBackend(),
    userAgent: buildUserAgent(fp),
    headers: fp.headers,
    capturedAt: fp.capturedAt,
    lastCheckedAt: fp.lastCheckedAt || null,
    stale,
  };
}

/**
 * Live client-fingerprint state for the Antigravity provider card.
 *
 * Reading it is cheap (cached snapshot + one `agy --version` call at most every
 * 5 minutes). A stale snapshot triggers a background capture; the caller gets
 * the current values immediately and the next poll sees the refresh.
 */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (id !== "antigravity") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const fp = getFingerprint();
  const stale = needsRefresh();
  if (stale) void syncFingerprint().catch(() => {});
  return NextResponse.json(serialize(fp, stale));
}

export async function POST(_request, { params }) {
  const { id } = await params;
  if (id !== "antigravity") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await refreshFingerprint({ force: true });
  return NextResponse.json(serialize(getFingerprint(), needsRefresh()));
}
