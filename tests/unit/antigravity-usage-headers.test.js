import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const wireCalls = [];
const antigravityPostJson = vi.fn(async (url, opts = {}) => {
  wireCalls.push({ url, opts });
  if (url.includes(":loadCodeAssist")) {
    return {
      ok: true,
      status: 200,
      json: { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } },
      text: "{}",
    };
  }
  if (url.includes(":retrieveUserQuotaSummary")) return { ok: true, status: 200, json: { groups: [] }, text: "{}" };
  return { ok: true, status: 200, json: { models: {} }, text: "{}" };
});

vi.mock("../../open-sse/utils/antigravityWire.js", () => ({
  antigravityPostJson,
  antigravityFetch: vi.fn(),
  buildAntigravityHeaders: () => [],
  buildAntigravityHeaderObject: () => ({}),
  isAntigravityHost: () => true,
  sendWireRequest: vi.fn(),
  resetAntigravityWire: vi.fn(),
}));

describe("Antigravity usage requests", () => {
  beforeEach(() => {
    wireCalls.length = 0;
    antigravityPostJson.mockClear();
  });

  it("goes through the exact-wire sender with captured bodies", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("access-token", {});

    // loadCodeAssist + fetchAvailableModels + retrieveUserQuotaSummary
    expect(antigravityPostJson).toHaveBeenCalledTimes(3);
    for (const call of wireCalls) {
      expect(call.opts.token).toBe("access-token");
      expect(call.url).toMatch(/^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:/);
    }

    const loadAssist = wireCalls.find(({ url }) => url.includes(":loadCodeAssist"));
    expect(loadAssist.opts.body).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
  });

  it("never reintroduces router-only or invented client headers", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      join(here, "../../open-sse/services/usage/google.js"),
      join(here, "../../open-sse/services/usage/antigravity-weekly.js"),
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toContain("X-Client-Name");
      expect(src, file).not.toContain("X-Client-Version");
      expect(src, file).not.toContain("x-request-source");
    }
  });
});
