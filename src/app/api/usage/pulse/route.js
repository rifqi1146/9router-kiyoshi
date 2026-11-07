import { NextResponse } from "next/server";
import { getProviderPulseStats } from "@/lib/db/repos/pulseRepo.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/pulse
 * Aggregated live provider health for the dashboard.
 * Query parameters:
 *   window (number) — sample size of most recent requests, clamped 10..1000 (default 200)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const windowRaw = parseInt(searchParams.get("window"), 10);
    const window = Number.isNaN(windowRaw) ? 200 : windowRaw;

    const stats = await getProviderPulseStats({ limit: window });
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to build provider pulse:", error);
    return NextResponse.json(
      { error: "Failed to build provider pulse" },
      { status: 500 }
    );
  }
}