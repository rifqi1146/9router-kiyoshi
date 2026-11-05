"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG, THEMES } from "@/shared/constants/config";

const THEME_IDS = THEMES.map((t) => t.id);

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,

      setTheme: (theme) => {
        if (!THEME_IDS.includes(theme)) return;
        set({ theme });
        applyTheme(get());
      },

      // Cycles Paper -> Charcoal -> AMOLED -> Paper. The header toggle is a
      // single button, so it has to walk all three rather than flip two.
      toggleTheme: () => {
        const current = get().theme;
        const next = THEME_IDS[(THEME_IDS.indexOf(current) + 1) % THEME_IDS.length];
        set({ theme: next });
        applyTheme(get());
      },

      initTheme: () => {
        applyTheme(get());
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
      version: 2,
      // v1 stored `{theme, palette}` with theme "system" and a violet palette.
      // Both are gone: system is replaced by the explicit three-theme cycle,
      // palette is replaced by the theme itself.
      migrate: (persisted) => {
        const legacyTheme = persisted?.theme;
        return {
          theme: THEME_IDS.includes(legacyTheme) ? legacyTheme : THEME_CONFIG.defaultTheme,
        };
      },
      partialize: (state) => ({ theme: state.theme }),
    }
  )
);

// Two classes on <html>:
//   .dark   -> the neutral charcoal theme, and the hook every `dark:` utility
//              in the codebase keys off. AMOLED also sets it, because AMOLED is
//              still a dark theme; only the surface tokens differ.
//   .amoled -> true-black surface overrides, layered on top of .dark.
function applyTheme({ theme }) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const isDarkTheme = theme === "dark" || theme === "amoled";

  root.classList.toggle("dark", isDarkTheme);
  root.classList.toggle("amoled", theme === "amoled");
}

export default useThemeStore;
