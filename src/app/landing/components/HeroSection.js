"use client";

import Link from "next/link";
import { APP_CONFIG } from "@/shared/constants/config";

export default function HeroSection() {
  return (
    <section className="relative pt-28 pb-16 sm:pt-36 sm:pb-24 px-4 sm:px-6 flex flex-col items-center justify-center">
      <div className="relative z-10 max-w-3xl w-full text-center flex flex-col items-center gap-6">
        {/* Version badge */}
        <div className="inline-flex items-center gap-2 rounded-chip bg-surface-2 px-3 py-1 text-xs font-semibold text-brass-700 dark:text-brass-300">
          <span className="size-1.5 rounded-full bg-brass-500" aria-hidden="true" />
          <span>v{APP_CONFIG.version} live</span>
        </div>

        {/* Main heading */}
        <h1 className="text-3xl sm:text-5xl md:text-6xl font-semibold tracking-tight text-text-main leading-tight">
          One endpoint for your AI routing
        </h1>

        {/* Description */}
        <p className="text-sm sm:text-base text-text-muted max-w-xl mx-auto leading-relaxed">
          Local reverse proxy gateway with web dashboard. Routes and manages keys for Claude Code, Codex, Cline, and local development environments.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 w-full max-w-md pt-2">
          <Link
            href="/dashboard"
            className="w-full sm:w-auto min-h-[44px] px-6 rounded-control bg-brand-800 hover:bg-brand-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">dashboard</span>
            Open dashboard
          </Link>
          <a
            href="https://github.com/decolua/9router"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto min-h-[44px] px-6 rounded-control border border-border bg-surface hover:bg-surface-2 text-text-main text-sm font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">code</span>
            View source
          </a>
        </div>
      </div>
    </section>
  );
}
