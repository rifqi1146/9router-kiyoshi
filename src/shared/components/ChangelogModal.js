"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import PropTypes from "prop-types";
import { GITHUB_CONFIG } from "@/shared/constants/config";
import { KIYOSHI_SPRING } from "./motion/KiyoshiMotion";

export default function ChangelogModal({ isOpen, onClose }) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || html) return;
    queueMicrotask(() => setLoading(true));
    queueMicrotask(() => setError(""));
    Promise.all([
      fetch(GITHUB_CONFIG.changelogUrl).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      }),
      import("marked"),
    ])
      .then(([md, { marked }]) => {
        marked.setOptions({ gfm: true, breaks: true });
        setHtml(marked.parse(md));
      })
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, html]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 bg-black/40 backdrop-blur-xs"
            onClick={onClose}
          />

          {/* Modal content */}
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={KIYOSHI_SPRING}
            className="relative w-full bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl max-w-3xl flex flex-col max-h-[85vh]"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-black/5 dark:border-white/5">
              <h2 className="text-lg font-semibold text-text-main">Change Log</h2>
              <button
                onClick={onClose}
                className="flex items-center justify-center min-w-[40px] min-h-[40px] rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                aria-label="Close"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {/* Body */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1">
              {loading && (
                <div className="flex items-center justify-center py-10 text-text-muted">
                  <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
                  Loading...
                </div>
              )}
              {error && (
                <div className="text-red-500 py-4">Failed to load changelog: {error}</div>
              )}
              {!loading && !error && html && (
                <div
                  className="changelog-body text-text-main"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

ChangelogModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
