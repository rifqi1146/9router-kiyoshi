"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import PropTypes from "prop-types";
import { GITHUB_CONFIG } from "@/shared/constants/config";
import { KIYOSHI_SPRING } from "./motion/KiyoshiMotion";

export default function DonateModal({ isOpen, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || data) return;
    // Defer the synchronous loading/error reset into a microtask so no
    // setState runs synchronously in the effect body
    // (react-hooks/set-state-in-effect). The microtask resolves before
    // the next paint, so the spinner still shows during the fetch.
    queueMicrotask(() => {
      setLoading(true);
      setError("");
    });
    fetch(GITHUB_CONFIG.donateUrl, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, data]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 bg-black/40 backdrop-blur-xs"
            onClick={onClose}
          />
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={KIYOSHI_SPRING}
            className="relative w-full bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl max-w-3xl flex flex-col max-h-[85vh]"
          >
            <div className="flex items-center justify-between p-3 border-b border-black/5 dark:border-white/5">
              <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
                <span className="material-symbols-outlined text-pink-500">volunteer_activism</span>
                {data?.title || "Support 9Router-Kiyoshi"}
              </h2>
              <button
                onClick={onClose}
                className="flex items-center justify-center min-w-[40px] min-h-[40px] rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                aria-label="Close"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div className="p-4 sm:p-6 overflow-y-auto flex-1">
              {loading && (
                <div className="flex items-center justify-center py-10 text-text-muted">
                  <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
                  Loading...
                </div>
              )}
              {error && (
                <div className="text-red-500 py-4">Failed to load donate info: {error}</div>
              )}
              {!loading && !error && data && (
                <>
                  {data.message && (
                    <p className="text-text-muted text-sm mb-6 text-center">{data.message}</p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {data.channels?.map((ch) => (
                      <DonateChannelCard key={ch.id} channel={ch} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

function DonateChannelCard({ channel }) {
  const { label, description, icon, color, url, qr } = channel;
  const content = (
    <>
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
        style={{ backgroundColor: `${color}20`, color }}
      >
        <span className="material-symbols-outlined text-[26px]">{icon}</span>
      </div>
      <div className="font-semibold text-text-main mb-1">{label}</div>
      {description && (
        <div className="text-xs text-text-muted mb-3 text-center">{description}</div>
      )}
      {qr && (
        <img
          src={qr}
          alt={`${label} QR`}
          className="w-full max-w-[180px] aspect-square object-contain rounded-lg bg-white p-1"
        loading="lazy"
        decoding="async"
        />
      )}
    </>
  );

  return (
    <div className="flex flex-col items-center p-4 rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 hover:border-pink-500/40 transition-colors">
      {content}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-white hover:opacity-90 transition-opacity"
          style={{ backgroundColor: color }}
        >
          Open
          <span className="material-symbols-outlined text-[16px]">open_in_new</span>
        </a>
      )}
    </div>
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
