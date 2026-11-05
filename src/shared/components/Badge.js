"use client";

import { cn } from "@/shared/utils/cn";

/**
 * Status chips. Solid fills only; a 4% translucent tint at chip size reads as a
 * rendering artifact rather than a deliberate state marker.
 *
 * Sans, sentence case. The mono/uppercase variant turned every two-word status
 * into a shout and made "5 connected" look like a code token.
 */
const variants = {
  default: "bg-surface-2 text-text-muted",
  primary: "bg-brand-800 text-white dark:bg-brand-700",
  success: "bg-brand-700 text-white",
  warning: "bg-brass-500 text-white",
  error: "bg-clay-500 text-white",
  info: "bg-surface-2 text-text-main",
  quiet: "bg-transparent text-text-muted",
};

const sizes = {
  sm: "px-1.5 py-0.5 text-[10px] gap-1",
  md: "px-2 py-0.5 text-[11px] gap-1",
  lg: "px-2.5 py-1 text-xs gap-1.5",
};

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-chip font-medium leading-none whitespace-nowrap",
        variants[variant],
        sizes[size],
        className
      )}
    >
      {dot && (
        <span
          className={cn(
            "size-1.5 rounded-full shrink-0",
            variant === "success" && "bg-brand-200",
            variant === "warning" && "bg-brass-200",
            variant === "error" && "bg-clay-100",
            variant === "info" && "bg-brass-500",
            variant === "primary" && "bg-brand-200",
            variant === "quiet" && "bg-brand-600 dark:bg-brand-400",
            variant === "default" && "bg-text-muted"
          )}
          aria-hidden="true"
        />
      )}
      {icon && (
        <span className="material-symbols-outlined text-[12px] leading-none" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}
