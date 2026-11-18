// First-token watchdog for upstreams that accept a turn and then stay silent on
// the wire for tens of seconds (Antigravity: 56-127 s on ~60 K-token agent
// prompts, measured 2026-11-18, while deepseek answers the same context in 2-4 s).
//
// The deadline is measured against the first chunk that carries something a
// client can use — answer text OR reasoning text. It is NOT measured on raw
// bytes: the translator emits role-only frames within milliseconds, so a
// byte-level guard passes instantly and the client still waits a minute.
// Reasoning counts because Gemini streams its thinking first; buffering it would
// hide real progress and turn a 5 s first look into a 60 s silence.
// Bytes read while waiting are buffered and replayed, so a passing stream loses
// nothing.

const CONTENT_EVENTS = new Set([
  "content_block_delta",
  "content_block_start",
  "response.output_text.delta",
  "response.output_item.added",
  "response.output_item.done",
]);

export class FirstTokenTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`upstream sent no first token within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "FirstTokenTimeoutError";
    this.code = "FIRST_TOKEN_TIMEOUT";
    this.status = 504;
  }
}

// True when the parsed SSE object carries visible answer text or thinking text.
function carriesProgress(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.type === "string" && !Array.isArray(obj.choices)) {
    if (!CONTENT_EVENTS.has(obj.type)) return false;
    const d = obj.delta || {};
    return Boolean(
      (typeof d.text === "string" && d.text.length > 0)
      || (typeof d.thinking === "string" && d.thinking.length > 0)
      || (typeof d.partial_json === "string" && d.partial_json.length > 0)
    );
  }
  for (const choice of obj.choices || []) {
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === "string" && delta.content.length > 0) return true;
    if (Array.isArray(delta.content) && delta.content.length > 0) return true;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (choice.finish_reason) return true;
  }
  return false;
}

function splitDataLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    out.push(payload);
  }
  return out;
}

// Returns a stream that replays everything read so far, then the rest of the
// upstream. Throws FirstTokenTimeoutError when nothing usable arrives in time.
export async function guardStreamFirstContent(stream, timeoutMs) {
  if (!timeoutMs || !stream) return stream;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const head = [];
  let sawProgress = false;
  let pending = "";
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });

  try {
    for (;;) {
      const res = await Promise.race([reader.read(), timeout]);
      if (res === null) {
        reader.cancel().catch(() => {});
        throw new FirstTokenTimeoutError(timeoutMs);
      }
      if (res.done) break;
      head.push(res.value);
      const text = pending + decoder.decode(res.value, { stream: true });
      const lines = text.split("\n");
      pending = lines.pop() || "";
      for (const payload of splitDataLines(lines.join("\n"))) {
        try {
          if (carriesProgress(JSON.parse(payload))) { sawProgress = true; break; }
        } catch { /* partial JSON: wait for more */ }
      }
      // Content-free streams that already finished must be passed through too.
      if (sawProgress) break;
    }
  } finally {
    clearTimeout(timer);
  }

  return new ReadableStream({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// Response-shaped wrapper for callers that already hold a fetch Response.
export async function guardFirstToken(response, timeoutMs) {
  if (!timeoutMs || !response?.body) return response;
  const body = await guardStreamFirstContent(response.body, timeoutMs);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
