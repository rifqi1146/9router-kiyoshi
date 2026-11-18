import { describe, expect, it } from "vitest";

import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("Antigravity Gemini 3.8 thinking levels", () => {
  it("advertises low/medium/high — upstream rejects minimal", () => {
    for (const provider of ["antigravity", "ag"]) {
      expect(getThinkingLevels(provider, "gemini-3.8-flash")).toEqual(["low", "medium", "high"]);
    }
  });

  it("keeps minimal on the public Gemini surface", () => {
    expect(getThinkingLevels("gemini", "gemini-3.8-flash")).toContain("minimal");
  });

  it("clamps reasoning_effort none to low on the Antigravity wire", () => {
    const body = {
      reasoning_effort: "none",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };
    applyThinking("antigravity", "gemini-3.8-flash", body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(
      "gemini-3.8-flash",
      body,
      true,
      { projectId: "project", connectionId: "connection" }
    );
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });
});
