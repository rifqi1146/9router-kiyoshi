"use client";

import Link from "next/link";
import { APP_CONFIG } from "@/shared/constants/config";

export default function Footer() {
  return (
    <footer className="border-t border-border-subtle bg-surface/50 py-10 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-text-muted">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center size-6 rounded-chip bg-brand-800 text-white">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">hub</span>
          </div>
          <span className="font-semibold text-text-main">{APP_CONFIG.name}</span>
          <span>v{APP_CONFIG.version}</span>
        </div>
        <div className="flex items-center gap-5">
          <Link href="/dashboard" className="hover:text-text-main transition-colors">
            Dashboard
          </Link>
          <a
            href="https://github.com/decolua/9router"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-main transition-colors"
          >
            GitHub
          </a>
          <span className="text-text-subtle">MIT License</span>
        </div>
      </div>
    </footer>
  );
}
