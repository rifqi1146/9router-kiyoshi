"use client";

import { useId } from "react";
import { cn } from "@/shared/utils/cn";

/**
 * Form field. The only place a border is allowed, and only because a field
 * with no edge is unreadable before it is focused. Rest: hairline. Hover:
 * brass. Focus: brass, one ring, no glow.
 */
export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
  id,
  ...props
}) {
  const autoId = useId();
  const fieldId = id || autoId;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={fieldId} className="text-xs font-semibold text-text-main">
          {label}
          {required && <span className="text-clay-500 ml-1" aria-hidden="true">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-text-muted">
            <span className="material-symbols-outlined text-[19px]" aria-hidden="true">{icon}</span>
          </div>
        )}
        <input
          id={fieldId}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          required={required}
          aria-invalid={error ? "true" : undefined}
          className={cn(
            "w-full min-h-[44px] sm:min-h-0 py-2.5 px-3 text-sm text-text-main bg-surface",
            "rounded-control border border-border",
            "placeholder:text-text-subtle",
            "hover:border-border-strong focus:border-border-strong focus:outline-none",
            "transition-colors duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface-2",
            // iOS zooms any field under 16px, so phones get 16px and desktop 14px.
            "text-[16px] sm:text-sm",
            icon && "pl-10",
            error && "border-clay-500 focus:border-clay-500",
            inputClassName
          )}
          {...props}
        />
      </div>
      {error && (
        <p className="text-xs text-clay-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
