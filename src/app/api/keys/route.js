import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getAllKeyUsage, getKeyUsageTotals } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys with usage stats
export async function GET() {
  try {
    const [keys, usageMap, totals] = await Promise.all([
      getApiKeys(),
      getAllKeyUsage(),
      getKeyUsageTotals(),
    ]);
    const enriched = keys.map((k) => ({
      ...k,
      usage: usageMap[k.key] || {
        totalTokens: 0,
        dailyTokens: 0,
        requests: 0,
        lastUsed: null,
      },
    }));
    // `totals` is every request that ever carried a key, deleted ones included.
    // The page summary reads this instead of summing the visible cards, so
    // deleting a key never rewinds the all-time counters.
    return NextResponse.json({ keys: enriched, totals });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, tokenLimit, tokenResetPeriod, expiresAt, access, injection } = body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let parsedAccess = undefined;
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      parsedAccess = checked.value;
    }

    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name.trim(), machineId, {
      tokenLimit,
      tokenResetPeriod,
      expiresAt,
      access: parsedAccess,
      injection: injection !== false,
    });

    return NextResponse.json(
      {
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        machineId: apiKey.machineId,
        isActive: apiKey.isActive,
        createdAt: apiKey.createdAt,
        tokenLimit: apiKey.tokenLimit,
        tokenResetPeriod: apiKey.tokenResetPeriod,
        expiresAt: apiKey.expiresAt,
        expired: apiKey.expired,
        access: apiKey.access,
        injection: apiKey.injection,
        usage: { totalTokens: 0, dailyTokens: 0, requests: 0, lastUsed: null },
      },
      { status: 201 }
    );
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
