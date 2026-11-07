"use client";

// useProviderPulse — live provider health for the Pulse dashboard page.
// Reads from /api/usage/pulse and never serves a stale mount-time snapshot:
//   1. Mount fetch (and re-fetch whenever the window size changes)
//   2. SETTINGS_CHANGED_EVENT — observability toggles, provider activation
//   3. Window focus — another tab or CLI may have changed state
//   4. Tab visibility — resume polling when the page becomes visible
//   5. 6s interval — requestDetails flushes to SQLite every 5s,
//      so 6s keeps the numbers fresh without hammering the DB.
// All fetches are abortable; rapid signal bursts cannot overwrite newer data.

import { useCallback, useEffect, useRef, useState } from "react";
import { SETTINGS_CHANGED_EVENT } from "@/shared/lib/outboundManifest";

const POLL_INTERVAL_MS = 6000;
const EMPTY = {
  loaded: false,
  data: null,
  error: null,
  updatedAt: null,
};

export function useProviderPulse(windowSize = 200) {
  const [state, setState] = useState(EMPTY);
  const inFlightRef = useRef(null);

  const refresh = useCallback(() => {
    if (inFlightRef.current) {
      inFlightRef.current.abort();
    }
    const ctrl = new AbortController();
    inFlightRef.current = ctrl;

    fetch(`/api/usage/pulse?window=${windowSize}`, {
      cache: "no-store",
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (ctrl.signal.aborted || inFlightRef.current !== ctrl) return;
        setState({
          loaded: true,
          data: json,
          error: json.error || null,
          updatedAt: Date.now(),
        });
      })
      .catch((err) => {
        if (ctrl.signal.aborted || err?.name === "AbortError" || inFlightRef.current !== ctrl) return;
        setState((prev) => ({
          ...prev,
          loaded: true,
          error: err?.message || "Failed to load pulse data",
        }));
      })
      .finally(() => {
        if (inFlightRef.current === ctrl) inFlightRef.current = null;
      });
  }, [windowSize]);

  useEffect(() => {
    refresh();

    const onSignal = () => refresh();
    globalThis.addEventListener?.(SETTINGS_CHANGED_EVENT, onSignal);
    globalThis.addEventListener?.("focus", onSignal);

    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let timer = null;
    const startPolling = () => {
      if (timer || document.visibilityState === "hidden") return;
      timer = setInterval(refresh, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      clearInterval(timer);
      timer = null;
    };
    const onPollVisibility = () => {
      if (document.visibilityState === "hidden") stopPolling();
      else {
        startPolling();
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onPollVisibility);
    startPolling();

    return () => {
      globalThis.removeEventListener?.(SETTINGS_CHANGED_EVENT, onSignal);
      globalThis.removeEventListener?.("focus", onSignal);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("visibilitychange", onPollVisibility);
      stopPolling();
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, [refresh]);

  return { ...state, refresh };
}
