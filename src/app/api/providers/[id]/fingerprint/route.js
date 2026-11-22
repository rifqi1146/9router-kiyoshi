import { NextResponse } from "next/server";
import { buildUserAgent, getFingerprint, needsRefresh, syncFingerprint } from "open-sse/services/antigravityFingerprint.js";

export const dynamic = "force-dynamic";

function serialize(fp, stale) {
  return {
    source: fp.source,
    version: fp.version,
    liveVersion: fp.liveVersion,
    cl: fp.cl,
    userAgent: buildUserAgent(fp),
    headers: fp.headers,
    capturedAt: fp.capturedAt,
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
  await syncFingerprint({ force: true });
  return NextResponse.json(serialize(getFingerprint(), needsRefresh()));
}
