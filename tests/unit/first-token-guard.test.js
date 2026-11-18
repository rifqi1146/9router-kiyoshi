import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { FirstTokenTimeoutError, guardStreamFirstContent } from "../../open-sse/utils/firstTokenGuard.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const enc = new TextEncoder();

const ROLE = 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
const CONTENT = 'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const REASONING = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n';
const EMPTY_CONTENT = 'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n';
const TOOL_CALL = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1"}]},"finish_reason":null}]}\n\n';

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

function handlerArgs(frames, { openStream = true, requestStartTime = Date.now() } = {}) {
  return {
    providerResponse: new Response(openStream ? open(frames) : closed(frames), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    provider: WATCHDOG_PROVIDER,
    model: "test-model",
    sourceFormat: "openai",
    targetFormat: "openai",
    userAgent: "probe",
    body: { messages: [] },
    stream: true,
    translatedBody: null,
    finalBody: null,
    requestStartTime,
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

const WATCHDOG_PROVIDER = "openai-compatible-watchdog-test";

afterEach(() => {
  delete PROVIDERS[WATCHDOG_PROVIDER];
});

describe("first-token watchdog wiring", () => {
  it("refuses an upstream that only sends role frames", async () => {
    PROVIDERS[WATCHDOG_PROVIDER] = { firstTokenTimeoutMs: 80 };
    const started = Date.now();
    const result = await handleStreamingResponse(handlerArgs([ROLE]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toMatch(/no first token/);
  });

  it("counts the budget from the request start, so a slow header phase fails the turn over", async () => {
    PROVIDERS[WATCHDOG_PROVIDER] = { firstTokenTimeoutMs: 100 };
    const started = Date.now();
    const result = await handleStreamingResponse(
      handlerArgs([ROLE], { requestStartTime: Date.now() - 5000 })
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
  });

  it("delivers the stream when reasoning arrives in time", async () => {
    PROVIDERS[WATCHDOG_PROVIDER] = { firstTokenTimeoutMs: 5000 };
    const result = await handleStreamingResponse(handlerArgs([ROLE, REASONING], { openStream: false }));
    expect(result.success).toBe(true);
    const text = await new Response(result.response.body).text();
    expect(text).toContain("thinking");
  });
});
