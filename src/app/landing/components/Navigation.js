"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const router = useRouter();

  const links = [
    { label: "Features", href: "#features" },
    { label: "How it works", href: "#how-it-works" },
    { label: "Docs", href: "https://github.com/decolua/9router#readme", external: true },
    { label: "GitHub", href: "https://github.com/decolua/9router", external: true },
  ];

  return (
    <nav className="fixed top-0 z-50 w-full bg-bg/95 border-b border-border-subtle">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Logo */}
        <button
          type="button"
          className="flex items-center gap-3 cursor-pointer bg-transparent border-none p-0 min-w-0"
          onClick={() => router.push("/")}
          aria-label="9Router-Kiyoshi home"
        >
          <div className="flex items-center justify-center size-8 rounded-chip bg-brand-800 text-white shrink-0">
            <span className="material-symbols-outlined text-[19px]" aria-hidden="true">hub</span>
          </div>
          <span className="text-text-main text-lg font-semibold tracking-tight truncate">
            9Router-Kiyoshi
          </span>
        </button>

        {/* Desktop menu */}
        <div className="hidden md:flex items-center gap-7">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className="text-text-muted hover:text-text-main text-sm font-medium transition-colors"
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* CTA + Mobile menu */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/dashboard")}
            className="hidden sm:flex h-9 items-center justify-center rounded-control px-4 bg-brand-800 hover:bg-brand-700 text-white text-sm font-semibold transition-colors cursor-pointer"
          >
            Open dashboard
          </button>
          <button
            className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] text-text-main rounded-control hover:bg-surface-2 transition-colors cursor-pointer"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileMenuOpen}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {mobileMenuOpen ? "close" : "menu"}
            </span>
          </button>
        </div>
      </div>

      {/* Mobile menu dropdown */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-border-subtle bg-bg">
          <div className="flex flex-col gap-1 p-4">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center min-h-[44px] px-3 rounded-control text-text-muted hover:bg-surface-2 hover:text-text-main text-sm font-medium transition-colors"
              >
                {link.label}
              </a>
            ))}
            <button
              onClick={() => router.push("/dashboard")}
              className="mt-2 min-h-[44px] rounded-control bg-brand-800 hover:bg-brand-700 text-white text-sm font-semibold transition-colors cursor-pointer"
            >
              Open dashboard
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
