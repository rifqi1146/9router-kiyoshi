"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useNotificationStore } from "@/store/notificationStore";
import { PageTransition, KIYOSHI_SPRING } from "../motion/KiyoshiMotion";
import Sidebar from "../Sidebar";
import Header from "../Header";
function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "bg-brand-700 text-white",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "bg-clay-500 text-white",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "bg-brass-500 text-white",
      icon: "warning",
    };
  }
  return {
    wrapper: "bg-surface-3 text-text-main",
    icon: "info",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // Preload heavy usage charts in background when browser is idle
  useEffect(() => {
    const preload = () => {
      import("@/shared/components/UsageStats").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/UsageChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/ProviderBarChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/TopModelsChart").catch(() => {});
    };
    if (typeof window !== "undefined") {
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(preload, { timeout: 4000 });
        return () => window.cancelIdleCallback(id);
      }
      const timer = setTimeout(preload, 2500);
      return () => clearTimeout(timer);
    }
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen w-full overflow-hidden bg-bg">
        <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2 pointer-events-none">
          <AnimatePresence>
            {notifications.map((n) => {
              const style = getToastStyle(n.type);
              return (
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, y: -16, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9, y: -10 }}
                  transition={{ type: "spring", stiffness: 420, damping: 28 }}
                  className={`pointer-events-auto rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${style.wrapper}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="material-symbols-outlined text-[18px] leading-5">{style.icon}</span>
                    <div className="min-w-0 flex-1">
                      {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                      <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                    </div>
                    {n.dismissible ? (
                      <button
                        type="button"
                        onClick={() => removeNotification(n.id)}
                        className="text-current/70 hover:text-current cursor-pointer"
                        aria-label="Dismiss notification"
                      >
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    ) : null}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        {/* Mobile sidebar overlay */}
        <AnimatePresence>
          {sidebarOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/40 lg:hidden backdrop-blur-xs"
              onClick={() => setSidebarOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* Sidebar - Desktop */}
        <div className="hidden lg:flex">
          <Sidebar />
        </div>

        {/* Sidebar - Mobile */}
        <AnimatePresence>
          {sidebarOpen && (
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={KIYOSHI_SPRING}
              className="fixed inset-y-0 left-0 z-50 h-full overflow-hidden lg:hidden"
            >
              <Sidebar onClose={() => setSidebarOpen(false)} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main content */}
        <main className="flex flex-col flex-1 h-full min-w-0 relative transition-colors duration-300 isolate">
          <Header key={pathname} onMenuClick={() => setSidebarOpen(true)} />
          <div className={`flex-1 overflow-y-auto custom-scrollbar ${pathname === "/dashboard/basic-chat" ? "" : "p-3 sm:p-5 lg:p-8"} ${pathname === "/dashboard/basic-chat" ? "flex flex-col overflow-hidden" : ""}`}>
            {pathname === "/dashboard/basic-chat" ? (
              <div className="flex-1 w-full h-full flex flex-col">{children}</div>
            ) : (
              <PageTransition routeKey={pathname} className="max-w-7xl mx-auto">
                {children}
              </PageTransition>
            )}
          </div>
        </main>
      </div>
    </MotionConfig>
  );
}
