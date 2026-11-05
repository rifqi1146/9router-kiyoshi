"use client";
import { useEffect, useState } from "react";
import ProviderIcon from "@/shared/components/ProviderIcon";

const CLI_TOOLS = [
  { id: "claude", name: "Claude Code", image: "/providers/claude.png" },
  { id: "codex", name: "OpenAI Codex", image: "/providers/codex.png" },
  { id: "cline", name: "Cline", image: "/providers/cline.png" },
  { id: "cursor", name: "Cursor", image: "/providers/cursor.png" },
];

const PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "gemini", name: "Gemini" },
  { id: "copilot", name: "GitHub Copilot" },
];

export default function FlowAnimation() {
  const [activeFlow, setActiveFlow] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveFlow((prev) => (prev + 1) % PROVIDERS.length);
    }, 2400);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-full max-w-3xl relative h-[300px] hidden md:flex items-center justify-center">
      {/* 9Router-Kiyoshi Hub - Center */}
      <div className="relative z-20 size-28 rounded-full bg-surface border-2 border-brass-500 flex flex-col items-center justify-center gap-1">
        <span className="material-symbols-outlined text-3xl text-brass-600 dark:text-brass-300" aria-hidden="true">
          hub
        </span>
        <span className="text-[10px] font-bold text-text-main tracking-wider uppercase font-mono">
          Gateway
        </span>
      </div>

      {/* CLI Tools - Left side */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col gap-3">
        {CLI_TOOLS.map((tool) => (
          <div
            key={tool.id}
            className="flex items-center gap-2.5 p-1.5 rounded-control bg-surface border border-border-subtle text-xs font-semibold text-text-main"
          >
            <ProviderIcon
              src={tool.image}
              alt={tool.name}
              size={22}
              className="object-contain rounded shrink-0"
              fallbackText={tool.name.slice(0, 2).toUpperCase()}
            />
            <span className="pr-2">{tool.name}</span>
          </div>
        ))}
      </div>

      {/* SVG Lines from CLI to 9Router */}
      <svg
        className="absolute inset-0 w-full h-full z-10 pointer-events-none opacity-40"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M 140 60 C 230 80, 230 150, 310 150" fill="none" stroke="currentColor" strokeDasharray="4,4" strokeWidth="1.5" />
        <path d="M 140 120 C 230 130, 230 150, 310 150" fill="none" stroke="currentColor" strokeDasharray="4,4" strokeWidth="1.5" />
        <path d="M 140 180 C 230 170, 230 150, 310 150" fill="none" stroke="currentColor" strokeDasharray="4,4" strokeWidth="1.5" />
        <path d="M 140 240 C 230 220, 230 150, 310 150" fill="none" stroke="currentColor" strokeDasharray="4,4" strokeWidth="1.5" />
      </svg>

      {/* SVG Lines from 9Router to Providers */}
      <svg
        className="absolute inset-0 w-full h-full z-10 pointer-events-none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M 420 150 C 490 150, 490 60, 560 60" fill="none" stroke={activeFlow === 0 ? "var(--color-brass-500)" : "var(--color-border)"} strokeWidth={activeFlow === 0 ? "2" : "1"} />
        <path d="M 420 150 C 490 150, 490 120, 560 120" fill="none" stroke={activeFlow === 1 ? "var(--color-brass-500)" : "var(--color-border)"} strokeWidth={activeFlow === 1 ? "2" : "1"} />
        <path d="M 420 150 C 490 150, 490 180, 560 180" fill="none" stroke={activeFlow === 2 ? "var(--color-brass-500)" : "var(--color-border)"} strokeWidth={activeFlow === 2 ? "2" : "1"} />
        <path d="M 420 150 C 490 150, 490 240, 560 240" fill="none" stroke={activeFlow === 3 ? "var(--color-brass-500)" : "var(--color-border)"} strokeWidth={activeFlow === 3 ? "2" : "1"} />
      </svg>

      {/* AI Providers - Right side */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2 flex flex-col gap-3">
        {PROVIDERS.map((provider, idx) => (
          <div
            key={provider.id}
            className={`px-3 py-2 rounded-control bg-surface border text-xs font-semibold min-w-[120px] transition-colors ${
              activeFlow === idx
                ? "border-brass-500 text-brass-700 dark:text-brass-300"
                : "border-border-subtle text-text-muted"
            }`}
          >
            {provider.name}
          </div>
        ))}
      </div>
    </div>
  );
}
