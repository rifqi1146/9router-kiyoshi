"use client";

import { useEffect } from "react";
import useThemeStore from "@/store/themeStore";
import { THEMES } from "@/shared/constants/config";

export function useTheme() {
  const { theme, setTheme, toggleTheme, initTheme } = useThemeStore();

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  const active = THEMES.find((t) => t.id === theme) || THEMES[0];

  return {
    theme,
    setTheme,
    toggleTheme,
    themes: THEMES,
    activeTheme: active,
    isDark: theme === "dark" || theme === "amoled",
    isAmoled: theme === "amoled",
  };
}
