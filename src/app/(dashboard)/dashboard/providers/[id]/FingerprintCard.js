"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/shared/components";
import { SETTINGS_CHANGED_EVENT } from "@/shared/lib/outboundManifest";

/**
 * Live native-fingerprint state for the Antigravity provider.
 *
 * The values come from the installed `agy` binary, not from this build, so the
 * card has to re-read them: a binary update, a capture finishing, or a second
 * tab opening all change the answer without a reload. Mount + focus +
 * visibility are the three paths that catch those.
 */
const REFRESH_MS = 60_000;

function Row({ label, value, mono = false }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="w-28 shrink-0 text-xs text-text-muted">{label}</span>
      <span className={`min-w-0 break-all text-xs ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

export default function FingerprintCard() {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/providers/antigravity/fingerprint", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json());
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/providers/antigravity/fingerprint", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json());
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(load, 0);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("focus", load);
    window.addEventListener(SETTINGS_CHANGED_EVENT, load);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(initial);
      window.removeEventListener("focus", load);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, load);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [load]);

  const stale = state?.stale === true;
  const source = state?.source === "snapshot"
    ? "captured from binary"
    : state?.source === "bundled"
      ? "bundled snapshot"
      : "default fallback";

  return (
    <Card>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Native fingerprint</h2>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
              error
                ? "bg-red-500/10 text-red-500"
                : stale
                  ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">
              {error ? "error" : stale ? "sync_problem" : "check_circle"}
            </span>
            {error ? "unavailable" : stale ? "binary updated — capturing" : "in sync"}
          </span>
          <Button size="sm" variant="secondary" icon="sync" onClick={handleSync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-text-muted">{error}</p>
      ) : !state ? (
        <p className="text-xs text-text-muted">Reading…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Row label="Version" value={`${state.version}${state.liveVersion && state.liveVersion !== state.version ? ` (binary ${state.liveVersion})` : ""}`} />
          <Row label="Build (cl)" value={state.cl || "not captured"} mono />
          <Row label="Source" value={source} />
          <Row label="Headers" value={state.headers.join(", ")} mono />
          <Row label="User-Agent" value={state.userAgent || "-"} mono />
          {state.capturedAt && <Row label="Captured" value={new Date(state.capturedAt).toLocaleString()} />}
        </div>
      )}
    </Card>
  );
}
