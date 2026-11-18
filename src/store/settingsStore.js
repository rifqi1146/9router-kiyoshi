"use client";

import { create } from "zustand";
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";

let inFlightSettingsPromise = null;
let inFlightSummaryPromise = null;
let cachedSummary = null;
let summaryLastFetched = 0;

const useSettingsStore = create((set, get) => ({
  settings: null,
  loading: false,
  error: null,
  lastFetched: 0,

  invalidate: () => {
    summaryLastFetched = 0;
    set({ lastFetched: 0 });
  },

  fetchSettingsSummary: async ({ force = false } = {}) => {
    if (!force && cachedSummary && Date.now() - summaryLastFetched < CLIENT_STORE_TTL_MS) {
      return cachedSummary;
    }
    if (!force && inFlightSummaryPromise) return inFlightSummaryPromise;

    const p = (async () => {
      try {
        const res = await fetch("/api/settings?summary=1", { cache: "no-store" });
        if (!res.ok) return null;
        const data = await res.json();
        cachedSummary = data;
        summaryLastFetched = Date.now();
        return data;
      } catch {
        return null;
      } finally {
        if (inFlightSummaryPromise === p) inFlightSummaryPromise = null;
      }
    })();
    inFlightSummaryPromise = p;
    return p;
  },
  // Skips network when cache is fresh; coalesce concurrent in-flight requests
  fetchSettings: async ({ force = false } = {}) => {
    const { lastFetched, settings } = get();
    if (!force && settings && Date.now() - lastFetched < CLIENT_STORE_TTL_MS) return settings;
    if (inFlightSettingsPromise) return inFlightSettingsPromise;

    set({ loading: true, error: null });
    inFlightSettingsPromise = (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        if (res.ok) {
          set({ settings: data, loading: false, lastFetched: Date.now() });
          return data;
        }
        set({ error: data.error, loading: false });
      } catch (e) {
        set({ error: "Failed to fetch settings", loading: false });
      } finally {
        inFlightSettingsPromise = null;
      }
      return null;
    })();
    return inFlightSettingsPromise;
  },

  // PATCH server + merge into local cache (no extra fetch needed)
  patchSettings: async (patch) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return null;
      const updated = await res.json();
      // Merge, not replace: PATCH response omits GET-only fields (e.g. hasPassword)
      summaryLastFetched = 0;
      set({ settings: { ...get().settings, ...updated }, lastFetched: Date.now() });
      return updated;
    } catch {
      return null;
    }
  },
}));

export default useSettingsStore;
