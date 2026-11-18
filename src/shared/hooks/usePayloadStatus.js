"use client";

// usePayloadStatus — single source of truth for the header Shield indicator.
//
// The shield must be E2E, not a decoration: any change to any setting that
// affects outbound request shaping has to show up here without a reload.
// Three sync paths keep it honest:
//
//   1. Mount fetch          — initial state, and re-hydrates after a page nav.
//   2. SETTINGS_CHANGED_EVENT — every settings PATCH in the app dispatches this
//                              (see emitSettingsChanged below), so a toggle in
//                              the Jailbreaks card, the Penetration tab, the
//                              Transparency console or the Token Saver tab all
//                              propagate here instantly.
//   3. Focus / visibility   — settings can change from another tab, a CLI, or a
//                              second browser window; those paths never fire a
//                              local DOM event, so re-read on regain focus.
//
// Reads the raw persisted keys rather than any derived UI state, so the shield
// always describes what will actually be injected on the next /v1 request.

import { useCallback, useEffect, useRef, useState } from "react";
import { SETTINGS_CHANGED_EVENT } from "@/shared/lib/outboundManifest";
import { hasScopeAcknowledgement } from "@/shared/lib/tabConfig";
import useSettingsStore from "@/store/settingsStore";
const EMPTY = {
  loaded: false,
  injectionEnabled: false,
  registerLevel: "",
  registerChars: 0,
  identity: "",
  payloadLevel: "",
  payloadLabel: "",
  payloadChars: 0,
  payloadTokens: 0,
  carrierWarp: false,
  skillRouterActive: false,
  skillRouterChars: 0,
  skillRouterTokens: 0,
  savers: { rtk: false, headroom: false, caveman: false, ponytail: false, pxpipe: false },
  saverCount: 0,
  pentestAcked: false,
};

// Any saver that actually rewrites request/response text. rtkEnabled ships
// true by default but is a compressor, not an injector, so it is reported
// separately from the injection group.
function derive(raw) {
  const s = raw || {};
  const registerCustom = typeof s.injectionRegisterCustom === "string" ? s.injectionRegisterCustom : "";
  const godmodeCustom = typeof s.injectionGodmodeCustom === "string" ? s.injectionGodmodeCustom : "";
  const registerLevel = s.injectionRegisterLevel || "none";
  const payloadLevel = s.injectionGodmodeLevel || "classic";
  const skillRouter =
    typeof s.injectionSkillRouterCustom === "string" ? s.injectionSkillRouterCustom.trim() : "";
  const identity = typeof s.injectionIdentity === "string" ? s.injectionIdentity.trim() : "";

  const savers = {
    rtk: !!s.rtkEnabled,
    headroom: !!s.headroomEnabled,
    caveman: !!s.cavemanEnabled,
    ponytail: !!s.ponytailEnabled,
    pxpipe: !!s.pxpipeEnabled,
  };

  const payloadChars = typeof s.injectionGodmodeCustomLength === "number"
    ? s.injectionGodmodeCustomLength
    : godmodeCustom.length;
  const registerChars = typeof s.injectionRegisterCustomLength === "number"
    ? s.injectionRegisterCustomLength
    : registerCustom.length;
  const skillRouterChars = typeof s.injectionSkillRouterCustomLength === "number"
    ? s.injectionSkillRouterCustomLength
    : skillRouter.length;
  const skillRouterActive = typeof s.injectionSkillRouterActive === "boolean"
    ? s.injectionSkillRouterActive
    : !!skillRouter;
  const carrierWarp = typeof s.injectionCarrierWarp === "boolean"
    ? s.injectionCarrierWarp
    : identity.includes("[YOUR JAILBREAK HERE]");

  return {
    loaded: true,
    injectionEnabled: !!s.injectionEnabled,
    registerLevel,
    registerChars,
    identity,
    payloadLevel,
    payloadLabel: payloadLevel === "custom" ? "custom" : payloadLevel,
    payloadChars,
    payloadTokens: payloadChars ? Math.max(1, Math.round(payloadChars / 4)) : 0,
    carrierWarp,
    skillRouterActive,
    skillRouterChars,
    skillRouterTokens: skillRouterChars ? Math.max(1, Math.round(skillRouterChars / 4)) : 0,
    savers,
    saverCount: Object.values(savers).filter(Boolean).length,
    pentestAcked: hasScopeAcknowledgement(),
  };
}

export function usePayloadStatus() {
  const [status, setStatus] = useState(EMPTY);
  const mountedRef = useRef(true);

  const refresh = useCallback((force = false) => {
    useSettingsStore.getState().fetchSettingsSummary({ force })
      .then((data) => {
        if (!mountedRef.current) return;
        if (data) setStatus(derive(data));
        else setStatus((prev) => ({ ...prev, loaded: true }));
      })
      .catch(() => {
        if (mountedRef.current) setStatus((prev) => ({ ...prev, loaded: true }));
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh(false);
    const onChanged = () => refresh(true);
    globalThis.addEventListener?.(SETTINGS_CHANGED_EVENT, onChanged);
    globalThis.addEventListener?.("focus", onChanged);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      globalThis.removeEventListener?.(SETTINGS_CHANGED_EVENT, onChanged);
      globalThis.removeEventListener?.("focus", onChanged);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return status;
}