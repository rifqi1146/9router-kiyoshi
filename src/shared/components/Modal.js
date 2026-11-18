"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/shared/utils/cn";
import Button from "./Button";
import Tooltip from "./Tooltip";

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  showTrafficLights = false,
  className,
}) {
  const sizes = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    full: "max-w-4xl",
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={closeOnOverlay ? onClose : undefined}
          />

          {/* Modal content */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className={cn(
              "relative w-full bg-surface",
              "rounded-t-dialog sm:rounded-card shadow-elevated",
              "max-h-[92vh] sm:max-h-[85vh] flex flex-col overflow-hidden",
              sizes[size],
              className
            )}
          >
            {/* Header */}
            {title && (
              <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border-subtle shrink-0">
                <h2 className="text-base sm:text-lg font-semibold text-text-main leading-tight truncate">
                  {title}
                </h2>
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="flex items-center justify-center min-w-[44px] min-h-[44px] -mr-2 rounded-control text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
                </button>
              </div>
            )}

            {/* Body */}
            <div className="p-4 sm:p-6 overflow-y-auto custom-scrollbar flex-1">
              {children}
            </div>

            {/* Footer */}
            {footer && (
              <div className="flex items-center justify-end gap-2 sm:gap-3 p-4 sm:p-6 border-t border-border-subtle shrink-0 bg-surface">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={loading}
          >
            {cancelText}
          </Button>
          <Button
            variant={variant}
            size="sm"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-muted leading-relaxed">{message}</p>
    </Modal>
  );
}
