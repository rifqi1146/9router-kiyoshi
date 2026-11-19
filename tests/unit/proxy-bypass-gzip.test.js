import { describe, expect, it } from "vitest";
import { PassThrough } from "stream";
import zlib from "zlib";
import { createBypassResponse } from "../../open-sse/utils/proxyFetch.js";

function makeMockIncomingMessage(payloadBuf, headers = {}, statusCode = 200, statusMessage = "OK") {
  const stream = new PassThrough();
  stream.statusCode = statusCode;
  stream.statusMessage = statusMessage;
  stream.headers = headers;
  process.nextTick(() => {
    if (payloadBuf) stream.end(payloadBuf);
    else stream.end();
  });
  return stream;
}

describe("createBypassResponse decompression", () => {
  it("decompresses gzip JSON responses and strips content-encoding/content-length", async () => {
    const payload = { response: { candidates: [{ content: { parts: [{ inlineData: { data: "abc" } }] } }] } };
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
    const res = makeMockIncomingMessage(compressed, {
      "content-type": "application/json; charset=UTF-8",
      "content-encoding": "gzip",
      "content-length": String(compressed.length),
    });

    const webRes = createBypassResponse(res);
    expect(webRes.ok).toBe(true);
    expect(webRes.status).toBe(200);
    expect(webRes.headers.get("content-encoding")).toBeNull();
    expect(webRes.headers.get("content-length")).toBeNull();
    expect(webRes.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(await webRes.json()).toEqual(payload);
  });

  it("decompresses x-gzip, deflate, and br responses", async () => {
    const payload = { ok: true, msg: "compressed" };
    const raw = Buffer.from(JSON.stringify(payload));

    const xGzipRes = createBypassResponse(
      makeMockIncomingMessage(zlib.gzipSync(raw), { "content-encoding": "x-gzip" })
    );
    expect(await xGzipRes.json()).toEqual(payload);

    const deflateRes = createBypassResponse(
      makeMockIncomingMessage(zlib.deflateSync(raw), { "content-encoding": "deflate" })
    );
    expect(await deflateRes.json()).toEqual(payload);

    const brRes = createBypassResponse(
      makeMockIncomingMessage(zlib.brotliCompressSync(raw), { "content-encoding": "br" })
    );
    expect(await brRes.json()).toEqual(payload);
  });

  it("passes through uncompressed responses and preserves content-length", async () => {
    const raw = Buffer.from("data: {\"ok\":true}\n\n");
    const res = makeMockIncomingMessage(raw, {
      "content-type": "text/event-stream",
      "content-length": String(raw.length),
    });

    const webRes = createBypassResponse(res);
    expect(webRes.headers.get("content-type")).toBe("text/event-stream");
    expect(webRes.headers.get("content-length")).toBe(String(raw.length));
    expect(await webRes.text()).toBe("data: {\"ok\":true}\n\n");
  });

  it("handles 204 No Content without throwing on Response body", () => {
    const res = makeMockIncomingMessage(null, {}, 204, "No Content");
    const webRes = createBypassResponse(res);
    expect(webRes.status).toBe(204);
    expect(webRes.body).toBeNull();
  });
});
