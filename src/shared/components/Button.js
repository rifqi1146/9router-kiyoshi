"use client";

import { cn } from "@/shared/utils/cn";

/**
 * One button shape, four roles. Solid forest green is the action, brass is the
 * secondary emphasis, clay is destructive. No gradients, no glow.
 *
 * Sizes keep a 44px tap target on phones and tighten on desktop where the
 * pointer is precise.
 */
const variants = {
  primary:
    "bg-brand-800 text-white hover:bg-brand-700 active:bg-brand-900 dark:bg-brand-600 dark:hover:bg-brand-500 disabled:bg-surface-3 disabled:text-text-muted",
  secondary:
    "bg-surface-2 text-text-main hover:bg-surface-3 disabled:opacity-50",
  outline:
    "border border-border text-text-main hover:border-brass-500 hover:text-brass-700 dark:hover:text-brass-300",
  ghost:
    "text-text-muted hover:bg-surface-2 hover:text-text-main",
  danger:
    "bg-clay-500 text-white hover:bg-clay-700 disabled:bg-surface-3 disabled:text-text-muted",
  success:
    "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-surface-3 disabled:text-text-muted",
};

const sizes = {
  xs: "h-8 px-2.5 text-[11px] rounded-chip gap-1.5",
  sm: "h-9 px-3 text-xs rounded-control gap-1.5",
  md: "min-h-[44px] sm:min-h-0 sm:h-10 px-4 text-sm rounded-control gap-2",
  lg: "min-h-[48px] sm:min-h-0 sm:h-11 px-6 text-sm rounded-control gap-2",
};

const iconSizes = {
  xs: "text-[14px]",
  sm: "text-[16px]",
  md: "text-[18px]",
  lg: "text-[20px]",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  ...props
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center font-semibold transition-colors duration-150 ease-out cursor-pointer",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass-500",
        "disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        sizes[size],
        fullWidth && "w-full",
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className={cn("material-symbols-outlined animate-spin", iconSizes[size])} aria-hidden="true">
          progress_activity
        </span>
      ) : icon ? (
        <span className={cn("material-symbols-outlined", iconSizes[size])} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
      {iconRight && !loading && (
        <span className={cn("material-symbols-outlined", iconSizes[size])} aria-hidden="true">
          {iconRight}
        </span>
      )}
    </button>
  );
}
