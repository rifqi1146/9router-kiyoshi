import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FirstTokenTimeoutError, guardStreamFirstContent } from "../../open-sse/utils/firstTokenGuard.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const enc = new TextEncoder();
const ROLE = 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
const CONTENT = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n';
const DONE = "data: [DONE]\n\n";

// Emits each frame, then stays open (an upstream that accepted the turn and went quiet).
function openStreamOf(frames) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else return new Promise(() => {}); // never resolves: silent upstream
    },
  });
}

function closedStreamOf(frames) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else controller.close();
    },
  });
}

async function drain(stream) {
  return new Response(stream).text();
}

describe("guardStreamFirstContent", () => {
  it("waits past a role-only frame for real content and replays every byte", async () => {
    const guarded = await guardStreamFirstContent(closedStreamOf([ROLE, CONTENT, DONE]), 2000);
    expect(await drain(guarded)).toBe(ROLE + CONTENT + DONE);
  });

  it("times out when only role frames arrive and the upstream stays open", async () => {
    const started = Date.now();
    await expect(guardStreamFirstContent(openStreamOf([ROLE, ROLE]), 60)).rejects.toBeInstanceOf(FirstTokenTimeoutError);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("passes a content-free stream that already ended", async () => {
    const guarded = await guardStreamFirstContent(closedStreamOf([ROLE]), 2000);
    expect(await drain(guarded)).toBe(ROLE);
  });
});

const PROVIDER = "openai-compatible-watchdog-test";

const baseArgs = () => ({
  providerResponse: new Response(openStreamOf([]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }),
  provider: PROVIDER,
  model: "test-model",
  sourceFormat: "openai",
  targetFormat: "openai",
  userAgent: "probe",
  body: { messages: [] },
  stream: true,
  translatedBody: null,
  finalBody: null,
  requestStartTime: Date.now(),
  connectionId: "probe",
  apiKey: null,
  clientRawRequest: {},
  onRequestSuccess: null,
  reqLogger: { appendProviderChunk() {}, appendConvertedChunk() {}, logError() {} },
  toolNameMap: null,
  customToolNames: null,
  streamController: { handleError() {}, handleComplete() {}, isConnected: () => true },
  onStreamComplete: () => {},
  streamDetailId: "probe",
  pxpipe: null,
  reqTag: "",
  log: null,
  credentials: {},
});

afterEach(() => {
  delete PROVIDERS[PROVIDER];
});

describe("first-token watchdog wiring", () => {
  it("refuses a silent upstream with 504 instead of hanging", async () => {
    PROVIDERS[PROVIDER] = { firstTokenTimeoutMs: 60 };
    const started = Date.now();
    const result = await handleStreamingResponse(baseArgs());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toMatch(/no first token/);
  });

  it("does not let a role-only frame satisfy the deadline", async () => {
    PROVIDERS[PROVIDER] = { firstTokenTimeoutMs: 120 };
    const args = baseArgs();
    args.providerResponse = new Response(openStreamOf([ROLE]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const result = await handleStreamingResponse(args);
    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
  });

  it("delivers the stream when content arrives in time", async () => {
    PROVIDERS[PROVIDER] = { firstTokenTimeoutMs: 5000 };
    const args = baseArgs();
    args.providerResponse = new Response(closedStreamOf([ROLE, CONTENT, DONE]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const result = await handleStreamingResponse(args);
    expect(result.success).toBe(true);
    const text = await new Response(result.response.body).text();
    expect(text).toContain('"content":"ok"');
  });
});
