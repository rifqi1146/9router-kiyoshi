import { registerSession, unregisterSession, findPlugin } from "@/lib/mcp/stdioSseBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;

export async function GET(request, { params }) {
  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return new Response(`Unknown plugin: ${plugin}`, { status: 404 });
  }

  const encoder = new TextEncoder();
  const signal = request.signal;
  let sid;
  let closed = false;
  let keepalive;
  let teardown;

  const stream = new ReadableStream({
    start(controller) {
      // Idempotent teardown: stream cancel, abort signal, and enqueue failure all funnel here.
      teardown = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        signal?.removeEventListener("abort", teardown);
        if (sid) unregisterSession(plugin, sid);
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          teardown();
        }
      };
      sid = registerSession(plugin, send, teardown);
      // MCP SSE handshake: tell client where to POST messages.
      send(`event: endpoint\ndata: /api/mcp/${plugin}/message?sessionId=${sid}\n\n`);
      // Detects dead tunnel connections that never send a clean stream cancel.
      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      keepalive?.unref?.();
      if (signal?.aborted) teardown();
      else signal?.addEventListener("abort", teardown, { once: true });
    },
    cancel() {
      teardown?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
