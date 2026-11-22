import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;
let streamRoute;

async function readNextSseData(reader, decoder, bufferRef) {
  while (true) {
    const idx = bufferRef.text.indexOf("\n\n");
    if (idx !== -1) {
      const frame = bufferRef.text.slice(0, idx);
      bufferRef.text = bufferRef.text.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) return JSON.parse(dataLine.slice(6));
      continue;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream closed unexpectedly");
    bufferRef.text += decoder.decode(value, { stream: true });
  }
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-rt-"));
  process.env.DATA_DIR = tempDir;
  delete global._pendingRequests;
  delete global._lastErrorProvider;
  delete global._statsEmitter;
  delete global._pendingTimers;
  delete global._recentRing;
  delete global._connectionMapCache;
  delete global._statsEmitTimers;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  streamRoute = await import("@/app/api/usage/stream/route.js");
});

afterEach(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Realtime usage SSE stream & emitters", () => {
  it("rejects invalid period and channel query params with 400", async () => {
    const badPeriod = await streamRoute.GET(new Request("http://localhost/api/usage/stream?period=bogus"));
    expect(badPeriod.status).toBe(400);

    const badChannel = await streamRoute.GET(new Request("http://localhost/api/usage/stream?channel=bogus"));
    expect(badChannel.status).toBe(400);
  });

  it("pushes pending snapshot before first update and full period-scoped stats on update", async () => {
    const ac = new AbortController();
    const res = await streamRoute.GET(
      new Request("http://localhost/api/usage/stream?period=today", { signal: ac.signal })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("cache-control")).toContain("no-transform");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const buf = { text: "" };

    const initial = await readNextSseData(reader, decoder, buf);
    expect(initial.activeRequests).toEqual([]);
    expect(initial.pending).toEqual({ byModel: {}, byAccount: {} });

    // Pending event before any update must still push live pending counts
    db.trackPendingRequest("gemini-3.8-flash", "antigravity", "conn-1", true);
    const pendingMsg = await readNextSseData(reader, decoder, buf);
    expect(pendingMsg.pending.byModel["gemini-3.8-flash (antigravity)"]).toBe(1);
    expect(pendingMsg.activeRequests).toHaveLength(1);

    // Completing a request saves usage and emits full period-scoped stats
    db.trackPendingRequest("gemini-3.8-flash", "antigravity", "conn-1", false);
    await db.saveRequestUsage({
      provider: "antigravity",
      model: "gemini-3.8-flash",
      connectionId: "conn-1",
      tokens: { prompt_tokens: 1200, completion_tokens: 340, cached_tokens: 800 },
      endpoint: "/v1/chat/completions",
      status: "ok",
    });

    let fullMsg;
    for (let i = 0; i < 5; i++) {
      const msg = await readNextSseData(reader, decoder, buf);
      if (typeof msg.totalRequests === "number" && msg.totalRequests >= 1) {
        fullMsg = msg;
        break;
      }
    }
    expect(fullMsg).toBeDefined();
    expect(fullMsg.totalRequests).toBe(1);
    expect(fullMsg.totalPromptTokens).toBe(1200);
    expect(fullMsg.totalCompletionTokens).toBe(340);
    expect(fullMsg.totalCachedTokens).toBe(800);

    ac.abort();
    await reader.cancel();
  });

  it("emits details event on channel=details when requestDetails flushes", async () => {
    await db.updateSettings({
      enableObservability: true,
      observabilityBatchSize: 1,
      observabilityFlushIntervalMs: 50,
    });

    const ac = new AbortController();
    const res = await streamRoute.GET(
      new Request("http://localhost/api/usage/stream?channel=details", { signal: ac.signal })
    );
    expect(res.status).toBe(200);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const buf = { text: "" };

    const ready = await readNextSseData(reader, decoder, buf);
    expect(ready.type).toBe("details-ready");

    await db.saveRequestDetail({
      provider: "antigravity",
      model: "gemini-3.8-flash",
      status: "success",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
    });

    const detailsMsg = await readNextSseData(reader, decoder, buf);
    expect(detailsMsg.type).toBe("details");
    expect(detailsMsg.count).toBeGreaterThanOrEqual(1);

    ac.abort();
    await reader.cancel();
  });
});
