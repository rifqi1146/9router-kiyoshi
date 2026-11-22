import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);
const VALID_CHANNELS = new Set(["stats", "details"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "all";
  const channel = searchParams.get("channel") || "stats";

  if (!VALID_CHANNELS.has(channel)) {
    return Response.json({ error: "Invalid channel" }, { status: 400 });
  }
  if (channel === "stats" && !VALID_PERIODS.has(period)) {
    return Response.json({ error: "Invalid period" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const state = {
    closed: false,
    sending: false,
    dirty: false,
    keepalive: null,
    send: null,
    sendPending: null,
    sendDetails: null,
    cachedStats: null,
    cleanup: null,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const cleanup = () => {
        if (state.closed) return;
        state.closed = true;
        if (state.send) statsEmitter.off("update", state.send);
        if (state.sendPending) statsEmitter.off("pending", state.sendPending);
        if (state.sendDetails) statsEmitter.off("details", state.sendDetails);
        clearInterval(state.keepalive);
        request?.signal?.removeEventListener("abort", cleanup);
      };
      state.cleanup = cleanup;
      request?.signal?.addEventListener("abort", cleanup, { once: true });

      if (channel === "details") {
        state.sendDetails = (payload) => {
          if (state.closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "details", ...(payload || {}), ts: payload?.ts || Date.now() })}\n\n`));
          } catch {
            cleanup();
          }
        };

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "details-ready", ts: Date.now() })}\n\n`));
        statsEmitter.on("details", state.sendDetails);
      } else {
        // Full stats refresh (coalesced per stream) + immediate lightweight push
        state.send = async () => {
          if (state.closed) return;
          if (state.sending) {
            state.dirty = true;
            return;
          }
          state.sending = true;
          try {
            do {
              state.dirty = false;
              if (state.closed) break;
              if (state.cachedStats) {
                const live = await getActiveRequests();
                if (state.closed) break;
                const quickStats = { ...state.cachedStats, ...live };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(quickStats)}\n\n`));
              }
              const stats = await getUsageStats(period);
              if (state.closed) break;
              state.cachedStats = stats;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
            } while (state.dirty && !state.closed);
          } catch {
            cleanup();
          } finally {
            state.sending = false;
          }
        };

        // Lightweight push: refresh activeRequests + recentRequests + pending immediately
        state.sendPending = async () => {
          if (state.closed) return;
          try {
            const live = await getActiveRequests();
            if (state.closed) return;
            const payload = state.cachedStats ? { ...state.cachedStats, ...live } : live;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            cleanup();
          }
        };

        const initial = await getActiveRequests();
        if (state.closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(initial)}\n\n`));

        statsEmitter.on("update", state.send);
        statsEmitter.on("pending", state.sendPending);
      }

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      state.cleanup?.();
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
