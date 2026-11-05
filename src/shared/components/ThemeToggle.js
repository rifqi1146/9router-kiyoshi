"use client";

import { useState, useRef, useEffect } from "react";
import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";

/**
 * Three-option theme toggle:
 *   - Paper:    warm paper + forest green
 *   - Charcoal: neutral charcoal dark
 *   - AMOLED:   true black OLED surfaces
 *
 * Click cycles themes; right-click (or hover on card variant) reveals the direct selector.
 */
export default function ThemeToggle({ className, variant = "default" }) {
  const { theme, setTheme, toggleTheme, themes, activeTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Icons:
  //   light:  wb_sunny / light_mode
  //   dark:   dark_mode
  //   amoled: contrast
  const getIcon = (t) => {
    if (t === "amoled") return "contrast";
    if (t === "dark") return "dark_mode";
    return "light_mode";
  };

  const variants = {
    default: cn(
      "relative flex items-center justify-center size-10 rounded-full",
      "text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
    ),
    card: cn(
      "relative flex items-center justify-center size-11 rounded-full",
      "bg-surface text-text-muted hover:text-text-main",
      "border border-border-subtle shadow-sm",
      "transition-all cursor-pointer"
    ),
  };

  return (
    <div
      ref={ref}
      className={cn("relative flex items-center", className)}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen((o) => !o);
      }}
    >
      <button
        type="button"
        onClick={toggleTheme}
        className={variants[variant]}
        aria-label={`Theme: ${activeTheme?.label || theme}. Click to cycle.`}
        title={`Theme: ${activeTheme?.label || theme} (Click to change)`}
      >
        <span className="material-symbols-outlined text-[20px]">
          {getIcon(theme)}
        </span>
      </button>

      {/* Direct 3-option picker popover on contextmenu / longpress */}
      {open && (
        <div
          className={cn(
            "absolute right-0 top-full mt-2 p-1.5 min-w-[150px]",
            "bg-surface border border-border-subtle",
            "rounded-card shadow-elevated z-50 animate-fade-in"
          )}
          onClick={() => setOpen(false)}
        >
          <div className="flex flex-col gap-0.5">
            {themes.map((t) => {
              const active = theme === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTheme(t.id)}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-control text-xs font-semibold transition-colors text-left w-full cursor-pointer",
                    active
                      ? "bg-brand-800 text-white"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {getIcon(t.id)}
                  </span>
                  <span className="flex-1">{t.label}</span>
                  {active && (
                    <span className="material-symbols-outlined text-[14px]">
                      check
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Kept as null placeholder so any external import doesn't crash.
 */
export function PaletteToggle() {
  return null;
}
