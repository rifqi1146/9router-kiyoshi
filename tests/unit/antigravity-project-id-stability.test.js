/**
 * Antigravity project id handling.
 *
 * Google links accounts by Cloud Code project, so the rule is simple and must
 * never regress: send the account's real project id, or send nothing at all.
 * Never invent one.
 *
 * Two things made this worth a test file:
 *  - `aicode-consumers` is what loadCodeAssist returns for Antigravity accounts.
 *    It is the real project, not a placeholder, and discarding it is what made
 *    the executor fabricate ids.
 *  - A fabricated project is a stronger abuse signal to Google than skipping the
 *    request, and it also broke prompt-cache affinity (Google keys the cache on
 *    (project, model, prefix)), which pushed TTFT to 20-70s.
 */

import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { isPlaceholderProjectId } from "../../open-sse/services/projectId.js";
import { isGenericProjectId } from "../../open-sse/services/antigravityHeaderScrub.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

const executor = new AntigravityExecutor();

describe("isPlaceholderProjectId", () => {
  it("keeps aicode-consumers — it is the real Cloud Code project", () => {
    expect(isPlaceholderProjectId("aicode-consumers")).toBe(false);
  });

  it("rejects only the literal test stubs", () => {
    expect(isPlaceholderProjectId("test-project")).toBe(true);
    expect(isPlaceholderProjectId("project-id")).toBe(true);
  });

  it("treats absent values as missing", () => {
    for (const v of ["", "  ", null, undefined, 42, {}]) {
      expect(isPlaceholderProjectId(v)).toBe(true);
    }
  });

  it("agrees with the header-scrub alias", () => {
    for (const id of ["aicode-consumers", "test-project", "real-proj-1", ""]) {
      expect(isGenericProjectId(id)).toBe(isPlaceholderProjectId(id));
    }
  });});

describe("transformRequest project resolution", () => {
  const body = () => ({
    model: "gemini-3.8-flash-medium",
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {},
      sessionId: "s1",
    },
  });

  it("sends the stored project id verbatim, including aicode-consumers", () => {
    const out = executor.transformRequest("gemini-3.8-flash-medium", body(), true, {
      connectionId: "conn-1",
      projectId: "aicode-consumers",
    });
    expect(out.project).toBe("aicode-consumers");
  });

  it("never fabricates a project id when the account has none", () => {
    const out = executor.transformRequest("gemini-3.8-flash-medium", body(), true, {
      connectionId: "conn-2",
      projectId: null,
    });
    expect(out.project).toBeFalsy();
  });

  it("is stable across requests for one account", () => {
    const creds = { connectionId: "conn-3", projectId: "aicode-consumers" };
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      ids.add(executor.transformRequest("gemini-3.8-flash-medium", body(), true, creds).project);
    }
    expect(ids.size).toBe(1);
  });
});

describe("Cloud Code envelope", () => {
  const openaiBody = {
    model: "gemini-3.8-flash",
    messages: [{ role: "user", content: "hi" }],
  };

  it("carries the real project id through the antigravity translator", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "gemini-3.8-flash",
      openaiBody,
      true,
      { projectId: "aicode-consumers", connectionId: "c1" },
      "antigravity"
    );
    expect(out.project).toBe("aicode-consumers");
  });

  it("does not invent a project id when none is supplied", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "gemini-3.8-flash",
      openaiBody,
      true,
      { connectionId: "c1" },
      "antigravity"
    );
    expect(out.project).toBeFalsy();
  });
});

describe("buildUrl", () => {
  it("always streams for text models, even when the client asked for JSON", () => {
    for (const stream of [true, false]) {
      expect(executor.buildUrl("gemini-3.8-flash", stream, 0)).toContain("streamGenerateContent?alt=sse");
    }
  });

  it("keeps the non-streaming endpoint for image models", () => {
    expect(executor.buildUrl("gemini-3.1-flash-image", true, 0)).toContain(":generateContent");
  });
});
