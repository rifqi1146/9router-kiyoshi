"use client";

import { cn } from "@/shared/utils/cn";

/**
 * Surface panel. Hierarchy comes from tone and spacing, not from a frame:
 * the card is one shade above the page, radius comes from the theme token,
 * and shadow is only used when the caller asks for elevation.
 */
export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  elev = false,
  className,
  ...props
}) {
  const paddings = {
    none: "",
    xs: "p-3",
    sm: "p-4",
    md: "p-5 sm:p-6",
    lg: "p-6 sm:p-8",
  };

  return (
    <div
      className={cn(
        "bg-surface rounded-card",
        elev && "shadow-[var(--shadow-elev)]",
        hover && "transition-all duration-200 ease-out hover:bg-surface-2 hover:-translate-y-0.5 hover:shadow-md cursor-pointer",
        paddings[padding],
        className
      )}
      {...props}
    >
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            {icon && (
              <div className="flex items-center justify-center size-9 shrink-0 rounded-control bg-surface-2 text-brass-600 dark:text-brass-300">
                <span className="material-symbols-outlined text-[19px]">{icon}</span>
              </div>
            )}
            <div className="min-w-0">
              {title && (
                <h3 className="text-text-main font-semibold leading-tight truncate">{title}</h3>
              )}
              {subtitle && (
                <p className="text-sm text-text-muted mt-0.5">{subtitle}</p>
              )}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

Card.Section = function CardSection({ children, className, ...props }) {
  return (
    <div
      className={cn("p-4 rounded-control bg-surface-2", className)}
      {...props}
    >
      {children}
    </div>
  );
};

Card.Row = function CardRow({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "py-3 transition-colors",
        "border-b border-border-subtle last:border-b-0",
        "hover:bg-surface-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.ListItem = function CardListItem({
  children,
  actions,
  className,
  ...props
}) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between gap-3 py-3",
        "border-b border-border-subtle last:border-b-0",
        "hover:bg-surface-2 transition-colors",
        className
      )}
      {...props}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {actions && (
        <div className="flex items-center gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
};
