"use client";

import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";

/**
 * Theme picker: three explicit modes. Rendered in the profile page and the
 * ThemeToggle popover so both entry points share one control.
 */
export default function ThemePalettePicker({ className }) {
  const { theme, setTheme, themes } = useTheme();

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {themes.map((t) => {
        const active = theme === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setTheme(t.id)}
            aria-pressed={active}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-control text-xs font-semibold transition-colors text-left cursor-pointer",
              active
                ? "bg-brand-800 text-white"
                : "text-text-muted hover:bg-surface-2 hover:text-text-main"
            )}
          >
            <span className="material-symbols-outlined text-[16px]">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
