// RequestDetailsTab token display helpers (issue #3890).
// The component is "use client" JSX, so the pure helpers live in
// tokenDisplay.js and are imported here directly.
import { describe, it, expect } from "vitest";
import { getOutputTokens, getInputTokens, getCachedTokens } from "@/app/(dashboard)/dashboard/usage/components/tokenDisplay.js";

describe("getOutputTokens — issue #3890", () => {
  it("Claude-format usage {output_tokens: 100} displays 100, not 0", () => {
    expect(getOutputTokens({ input_tokens: 50, output_tokens: 100 })).toBe(100);
  });

  it("OpenAI-format usage {completion_tokens: 100} still displays 100", () => {
    expect(getOutputTokens({ prompt_tokens: 50, completion_tokens: 100 })).toBe(100);
  });

  it("missing/empty tokens → 0, no throw", () => {
    expect(getOutputTokens(undefined)).toBe(0);
    expect(getOutputTokens(null)).toBe(0);
    expect(getOutputTokens({})).toBe(0);
    expect(() => getOutputTokens(undefined).toLocaleString()).not.toThrow();
  });

  it("input helper unchanged: Claude input_tokens fallback still works", () => {
    expect(getInputTokens({ input_tokens: 50 })).toBe(50);
  });

  it("reads cached tokens across all 4 provider slots", () => {
    expect(getCachedTokens({ cached_tokens: 120 })).toBe(120);
    expect(getCachedTokens({ cache_read_input_tokens: 240 })).toBe(240);
    expect(getCachedTokens({ prompt_tokens_details: { cached_tokens: 360 } })).toBe(360);
    expect(getCachedTokens({ input_tokens_details: { cached_tokens: 480 } })).toBe(480);
    expect(getCachedTokens(null)).toBe(0);
  });
});
