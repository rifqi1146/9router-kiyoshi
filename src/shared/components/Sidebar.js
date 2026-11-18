"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import useSettingsStore from "@/store/settingsStore";
import Button from "./Button";
import { ConfirmModal } from "./Modal";
import NineRemotePromoModal from "./NineRemotePromoModal";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt", "systemone"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

const navItems = [
  { href: "/dashboard/overview", label: "Server Overview", icon: "monitoring" },
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },
  { href: "/dashboard/api-keys", label: "Access Keys", icon: "vpn_key" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" }, // Hidden
  { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/pulse", label: "Provider Pulse", icon: "vital_signs" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
  // { href: "/dashboard/pxpipe", label: "PXPIPE", icon: "image" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
  { href: "/dashboard/developer", label: "Developer", icon: "developer_mode" },
  { href: "/dashboard/penetration", label: "Penetration", icon: "scanner" },
  { href: "/dashboard/strix", label: "Strix Skills", icon: "security" },
  { href: "/dashboard/payload", label: "Jailbreaks", icon: "gavel" },
  { href: "/dashboard/custom-payloads", label: "Custom Payloads", icon: "add_circle" },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

const systemItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
];

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
   const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdForPlatform(typeof navigator !== "undefined" ? navigator.platform : "") || UPDATER_CONFIG.installCmdLatest;

  useEffect(() => {
    useSettingsStore.getState().fetchSettings().then((data) => {
      if (data?.enableTranslator) setEnableTranslator(true);
    });
  }, []);

  // Lazy check for new npm version in background after initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch("/api/version")
        .then(res => res.json())
        .then(data => { setUpdateInfo(data); })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  const isActive = (href) => {
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  // Open manual update panel (no countdown yet — user must click Copy to trigger shutdown)
  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  // Triggered by Copy button inside ManualUpdatePanel: copy + countdown + shutdown
  const handleCopyAndShutdown = async (cmd) => {
    const target = cmd || INSTALL_CMD;
    try { await navigator.clipboard.writeText(target); } catch { /* clipboard blocked */ }
    copy(target);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  // Note: legacy updater poll removed. New flow: copy install cmd + shutdown server,
  // user runs the command manually in another terminal.


  return (
    <>
      <aside className="flex h-full w-72 flex-col border-r border-border-subtle bg-sidebar">
        {/* Logo */}
        <div className="px-5 py-5 flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between">
            <Link href="/dashboard" className="flex items-center gap-3 min-w-0" onClick={onClose}>
              <div className="flex items-center justify-center size-9 rounded-[10px] bg-brand-800 shrink-0">
                <span className="material-symbols-outlined text-white text-[20px]">hub</span>
              </div>
              <div className="flex flex-col min-w-0">
                <h1 className="text-[15px] font-semibold tracking-tight text-text-main truncate">
                  {APP_CONFIG.name}
                </h1>
                <span className="text-[11px] text-text-muted">v{APP_CONFIG.version}</span>
                <span className="text-[10px] text-text-subtle font-medium block">
                  based on 9router-plinian
                </span>
              </div>
            </Link>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close navigation"
                className="flex items-center justify-center min-w-[44px] min-h-[44px] -mr-2 rounded-control text-text-muted hover:text-text-main hover:bg-surface-2 lg:hidden cursor-pointer"
              >
                <span className="material-symbols-outlined text-[22px]">close</span>
              </button>
            )}
          </div>
          {/* Update status — always visible when the check has resolved:
              a banner for old builds pointing at the latest release, or a
              subtle "up to date" line on current installs. */}
          {updateInfo && (updateInfo.hasUpdate ? (
            <div className="flex flex-col gap-1.5 rounded-control bg-brass-100 dark:bg-surface-2 p-2.5 mt-1">
              <span className="text-[11px] font-semibold text-brass-700 dark:text-brass-300">
                New version available: v{updateInfo.latestVersion}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="px-2 py-1 rounded-chip bg-brand-800 hover:bg-brand-700 text-white text-[11px] font-semibold transition-colors cursor-pointer"
                >
                  Update
                </button>
                <button
                  onClick={() => copy(INSTALL_CMD)}
                  title="Copy install command"
                  className="flex-1 text-left min-w-0 cursor-pointer"
                >
                  <code className="block text-[10px] text-brass-700 dark:text-brass-300 font-mono truncate">
                    {copied ? "copied" : INSTALL_CMD}
                  </code>
                </button>
              </div>
            </div>
          ) : (
            <div className="px-1">
              <span className="text-[11px] text-text-subtle">
                v{updateInfo.currentVersion} up to date
              </span>
            </div>
          ))}
        </div>

        {/* Navigation */}
        <nav className="flex-1 min-h-0 px-4 py-2 space-y-0.5 overflow-y-auto overscroll-contain custom-scrollbar">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "relative flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group",
                  active
                    ? "text-white"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                )}
              >
                {active && (
                  <motion.div
                    layoutId={onClose ? "sidebar-mobile-active" : "sidebar-desktop-active"}
                    className="absolute inset-0 bg-brand-800 rounded-control"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  />
                )}
                <span
                  className={cn(
                    "relative z-10 material-symbols-outlined text-[18px]",
                    active ? "fill-1" : "group-hover:text-brass-500 transition-colors"
                  )}
                >
                  {item.icon}
                </span>
                <span className="relative z-10 text-[13px] font-medium">{item.label}</span>
              </Link>
            );
          })}

          {/* System section */}
          <div className="pt-3 mt-2 space-y-0.5">
            <p className="px-4 text-xs font-semibold text-text-muted/60 uppercase tracking-wider mb-2">
              System
            </p>

            {/* Media Providers accordion */}
            <button
              onClick={() => setMediaOpen((v) => !v)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-brand-800 text-white"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">perm_media</span>
              <span className="text-[13px] font-medium flex-1 text-left">Media Providers</span>
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            <AnimatePresence initial={false}>
              {mediaOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden pl-4"
                >
                  {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                    <Link
                      key={kind.id}
                      href={`/dashboard/media-providers/${kind.id}`}
                      onClick={onClose}
                      className={cn(
                        "flex items-center gap-3 px-4 py-2 sm:py-1.5 min-h-[36px] rounded-control transition-colors group",
                        pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                          ? "bg-brand-800 text-white"
                          : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                      )}
                    >
                      <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                      <span className="text-sm">{kind.label}</span>
                    </Link>
                  ))}
                  <Link
                    key={COMBINED_WEB_ITEM.id}
                    href={COMBINED_WEB_ITEM.href}
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2 sm:py-1.5 min-h-[36px] rounded-control transition-colors group",
                      pathname.startsWith(COMBINED_WEB_ITEM.href)
                        ? "bg-brand-800 text-white"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{COMBINED_WEB_ITEM.icon}</span>
                    <span className="text-sm">{COMBINED_WEB_ITEM.label}</span>
                  </Link>
                </motion.div>
              )}
            </AnimatePresence>

            {systemItems.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "relative flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group",
                    active
                      ? "text-white"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  {active && (
                    <motion.div
                      layoutId={onClose ? "sidebar-mobile-active" : "sidebar-desktop-active"}
                      className="absolute inset-0 bg-brand-800 rounded-control"
                      transition={{ type: "spring", stiffness: 420, damping: 32 }}
                    />
                  )}
                  <span
                    className={cn(
                      "relative z-10 material-symbols-outlined text-[18px]",
                      active ? "fill-1" : "group-hover:text-brass-500 transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="relative z-10 text-[13px] font-medium">{item.label}</span>
                </Link>
              );
            })}

            {/* Debug items (inside System section, before Settings) */}
            {debugItems.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              const active = isActive(item.href);
              return show ? (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "relative flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group",
                    active
                      ? "text-white"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  {active && (
                    <motion.div
                      layoutId={onClose ? "sidebar-mobile-active" : "sidebar-desktop-active"}
                      className="absolute inset-0 bg-brand-800 rounded-control"
                      transition={{ type: "spring", stiffness: 420, damping: 32 }}
                    />
                  )}
                  <span
                    className={cn(
                      "relative z-10 material-symbols-outlined text-[18px]",
                      active ? "fill-1" : "group-hover:text-brass-500 transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="relative z-10 text-[13px] font-medium">{item.label}</span>
                </Link>
              ) : null;
            })}

            {/* Remote */}
            <a
              href="https://9remote.cc"
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group w-full",
                "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] group-hover:text-brass-500 transition-colors">
                computer
              </span>
              <span className="text-[13px] font-medium">9Remote</span>
              <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-orange-500/15 text-orange-400">
                HOT
              </span>
            </a>

            {/* 9English */}
            <a
              href="https://9english.net/"
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group w-full",
                "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] group-hover:text-brass-500 transition-colors">
                translate
              </span>
              <span className="text-[13px] font-medium">9English</span>
            </a>

            {/* Attribution CTA — this build is a fork of 9Router-Kiyoshi */}
            <a
              href={APP_CONFIG.basedOn.url}
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group w-full",
                "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] group-hover:text-brass-500 transition-colors">
                fork_right
              </span>
              <span className="text-[13px] font-medium">{APP_CONFIG.basedOn.label}</span>
            </a>

            {/* Settings */}
            <Link
              href="/dashboard/profile"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-2 sm:py-1.5 min-h-[38px] rounded-control transition-colors group",
                isActive("/dashboard/profile")
                  ? "bg-brand-800 text-white"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive("/dashboard/profile") ? "fill-1" : "group-hover:text-brass-500 transition-colors"
                )}
              >
                settings
              </span>
              <span className="text-[13px] font-medium">Settings</span>
            </Link>
          </div>
        </nav>

      </aside>


      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update 9Router-Kiyoshi"
        message={`Show install command for v${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {/* Disconnected / Updating Overlay */}
      {(isDisconnected || isUpdating) && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Server Disconnected</h2>
              <p className="text-text-muted mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-xl bg-neutral-900/95 border border-white/10 p-6 text-white">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center size-11 rounded-full bg-amber-500/20 text-amber-400">
          <span className="material-symbols-outlined text-[24px]">content_copy</span>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Update 9Router-Kiyoshi{latestVersion ? ` to v${latestVersion}` : ""}</h2>
          <p className="text-xs text-white/60">
            {isDisconnected
              ? "Server stopped. Paste the command into a terminal to install."
              : isCountingDown
                ? `Command copied. Server will stop in ${countdown}s...`
                : "Click the button below to copy the install command and shutdown."}
          </p>
        </div>
      </div>

      <p className="text-sm text-white/80 mb-2">Install command:</p>
      <div className="w-full px-3 py-2 rounded bg-white/5 mb-4">
        <code className="text-xs font-mono text-amber-400 break-all">{installCmd}</code>
      </div>

      <ol className="text-xs text-white/70 space-y-1 list-decimal list-inside mb-4">
        <li>Click <strong>Copy & Shutdown</strong> below.</li>
        <li>Paste the command into your terminal and press Enter.</li>
        <li>Run <code className="px-1 rounded bg-white/10 text-green-400">9router</code> again after install.</li>
      </ol>

      {isDisconnected ? (
        <Button variant="secondary" fullWidth onClick={() => globalThis.location.reload()}>
          Reload Page
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={isCountingDown}>
            Cancel
          </Button>
          <Button variant="primary" fullWidth onClick={() => onCopyAndShutdown(installCmd)} disabled={isCountingDown}>
            {copied ? "✓ Copied — shutting down..." : isCountingDown ? `Shutting down in ${countdown}s` : "Copy & Shutdown"}
          </Button>
        </div>
      )}
    </div>
  );
}

ManualUpdatePanel.propTypes = {
  latestVersion: PropTypes.string,
  installCmd: PropTypes.string.isRequired,
  copied: PropTypes.bool,
  onCopyAndShutdown: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  isDisconnected: PropTypes.bool,
};
