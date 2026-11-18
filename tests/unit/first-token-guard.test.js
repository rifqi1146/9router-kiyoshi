import { afterEach, describe, expect, it, vi } from "vitest";

import { FirstTokenTimeoutError, guardStreamFirstContent } from "../../open-sse/utils/firstTokenGuard.js";

const enc = new TextEncoder();

function closed(frames) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else controller.close();
    },
  });
}

function open(frames) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else return new Promise(() => {});
    },
  });
}

const ROLE = 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
const CONTENT = 'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const REASONING = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n';
const EMPTY_CONTENT = 'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n';
const TOOL_CALL = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1"}]},"finish_reason":null}]}\n\n';

describe("guardStreamFirstContent", () => {
  it("buffers and replays every byte it consumed", async () => {
    const guarded = await guardStreamFirstContent(closed([ROLE, CONTENT]), 2000);
    expect(await new Response(guarded).text()).toBe(ROLE + CONTENT);
  });

  it("treats reasoning text as progress, so thinking streams are not buffered", async () => {
    const guarded = await guardStreamFirstContent(closed([ROLE, REASONING]), 2000);
    expect(await new Response(guarded).text()).toBe(ROLE + REASONING);
  });

  it("treats tool calls as progress", async () => {
    const guarded = await guardStreamFirstContent(closed([ROLE, TOOL_CALL]), 2000);
    expect(await new Response(guarded).text()).toContain("tool_calls");
  });

  it("does not count role-only or empty-content frames", async () => {
    const started = Date.now();
    await expect(guardStreamFirstContent(open([ROLE, EMPTY_CONTENT]), 80)).rejects.toBeInstanceOf(FirstTokenTimeoutError);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("passes a content-free stream that already ended", async () => {
    const guarded = await guardStreamFirstContent(closed([ROLE]), 2000);
    expect(await new Response(guarded).text()).toBe(ROLE);
  });

  it("returns unchanged when no timeout is configured", async () => {
    const stream = closed([ROLE]);
    await expect(guardStreamFirstContent(stream, 0)).resolves.toBe(stream);
  });
});

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const PROVIDER = "openai-compatible-watchdog-test";

function handlerArgs(frames, open_ = true) {
  return {
    providerResponse: new Response(open_ ? open(frames) : closed(frames), {
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
  };
}

afterEach(() => {
  delete PROVIDERS[PROVIDER];
});

const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");

describe("first-token watchdog wiring", () => {
  it("refuses an upstream that only sends role frames", async () => {
    PROVIDERS[PROVIDER] = { firstTokenTimeoutMs: 80 };
    const started = Date.now();
    const result = await handleStreamingResponse(handlerArgs([ROLE]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toMatch(/no first token/);
  });

  it("delivers the stream when reasoning arrives in time", async () => {
    PROVIDERS[PROVIDER] = { firstTokenTimeoutMs: 5000 };
    const result = await handleStreamingResponse(handlerArgs([ROLE, REASONING], false));
    expect(result.success).toBe(true);
    const text = await new Response(result.response.body).text();
    expect(text).toContain("thinking");
  });
});
