"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";
import { SETTINGS_CHANGED_EVENT } from "@/shared/lib/outboundManifest";

/**
 * Live native-fingerprint state for the Antigravity provider.
 *
 * The values come from the installed `agy` binary, not from this build, so the
 * card re-reads them: a binary update, a capture finishing, a second tab
 * opening, or a settings write all change the answer without a reload. Mount,
 * focus, visibility, the settings event and a 60s poll cover those paths.
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

// `stale` means the binary moved past the stored snapshot; `source: "default"`
// means neither a capture nor the bundled file exists, so every value shown is
// a constant from this build. Neither is "in sync".
function statusOf(state, error) {
  if (error) return { variant: "default", icon: "error", text: "unavailable" };
  if (!state) return { variant: "default", icon: "schedule", text: "reading" };
  if (state.stale === true) return { variant: "warning", icon: "sync_problem", text: "out of date" };
  if (state.source === "default") return { variant: "warning", icon: "sync_problem", text: "built-in fallback" };
  return { variant: "success", icon: "check_circle", text: "in sync" };
}

export default function FingerprintCard() {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  // A read that started earlier must never overwrite a newer answer, and no
  // poll should race the POST that is itself waiting on a capture.
  const latestRef = useRef(0);
  const syncingRef = useRef(false);

  const load = useCallback(async () => {
    const seq = ++latestRef.current;
    try {
      const res = await fetch("/api/providers/antigravity/fingerprint", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== latestRef.current) return;
      setState(data);
      setError("");
    } catch (e) {
      if (seq !== latestRef.current) return;
      setError(e.message || "request failed");
    }
  }, []);

  const refresh = useCallback(() => {
    if (syncingRef.current) return;
    load();
  }, [load]);

  const handleSync = useCallback(async () => {
    latestRef.current += 1;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await fetch("/api/providers/antigravity/fingerprint", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json());
      setError("");
    } catch (e) {
      setError(e.message || "sync failed");
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    // Deferred so the effect body itself does not set state on mount.
    const initial = setTimeout(load, 0);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const poll = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(poll, REFRESH_MS);
    return () => {
      clearTimeout(initial);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [load, refresh]);

  const status = statusOf(state, error);
  const source = state?.source === "snapshot"
    ? "captured from binary"
    : state?.source === "bundled"
      ? "bundled snapshot"
      : "built-in fallback";
  const headers = Array.isArray(state?.headers) ? state.headers.join(", ") : "not reported";
  const version = state?.version || "unknown";
  const drift = state?.liveVersion && state.liveVersion !== state.version ? ` (binary ${state.liveVersion})` : "";
  const backend = state?.tlsBackend?.backend === "go-crypto-tls" ? "go-crypto-tls" : "node-openssl";
  const backendLabel = backend === "go-crypto-tls" && state?.tlsBackend?.active !== true
    ? "go-crypto-tls (not running)"
    : backend;

  return (
    <Card>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Native fingerprint</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-live="polite">
            <Badge variant={status.variant} icon={status.icon}>{status.text}</Badge>
          </span>
          <Button size="md" variant="secondary" icon="sync" onClick={handleSync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-text-muted">Could not read the fingerprint: {error}. Sync retries the capture.</p>
      ) : !state ? (
        <p className="text-xs text-text-muted">Reading the installed agy binary…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Row label="Version" value={`${version}${drift}`} />
          <Row label="Build (cl)" value={state.cl || "not captured"} mono />
          <Row label="Source" value={source} />
          <Row label="ALPN" value={state.alpnProtocol === "h2" ? "h2" : "http/1.1"} mono />
          <Row label="TLS" value={backendLabel} mono />
          <Row label="Headers" value={headers} mono />
          <Row label="User-Agent" value={state.userAgent || "-"} mono />
          {state.capturedAt && <Row label="Captured" value={new Date(state.capturedAt).toLocaleString()} />}
        </div>
      )}
    </Card>
  );
}
