"use client";

import { motion } from "motion/react";
import { cn } from "@/shared/utils/cn";

export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
}) {
  const sizes = {
    sm: "h-7 text-xs px-3",
    md: "h-9 text-sm px-4",
    lg: "h-11 text-base px-5",
  };

  // Unique layoutId per instance based on options
  const layoutId = `segmented-${options.map((o) => o.value).join("-")}`;

  return (
    <div
      className={cn(
        "inline-flex items-center p-1 rounded-[10px] overflow-x-auto no-scrollbar",
        "bg-surface-2 relative",
        className
      )}
    >
      {options.map((option) => {
        const isSelected = value === option.value;
        return (
          <button
            type="button"
            key={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative shrink-0 rounded-[8px] font-medium transition-colors duration-150 select-none cursor-pointer flex items-center justify-center",
              sizes[size],
              isSelected
                ? "text-text-main"
                : "text-text-muted hover:text-text-main"
            )}
          >
            {isSelected && (
              <motion.div
                layoutId={layoutId}
                className="absolute inset-0 bg-surface rounded-[8px] shadow-sm"
                transition={{ type: "spring", stiffness: 450, damping: 32 }}
              />
            )}
            <span className="relative z-10 flex items-center">
              {option.icon && (
                <span className="material-symbols-outlined text-[16px] mr-1.5" aria-hidden="true">
                  {option.icon}
                </span>
              )}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
