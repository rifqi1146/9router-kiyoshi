"use client";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function GetStarted() {
  const { copied, copy } = useCopyToClipboard();

  const handleCopy = (text) => {
    copy(text, "landing");
  };

  return (
    <section className="py-16 sm:py-20 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row gap-10 lg:gap-14 items-start">
          {/* Left: Steps */}
          <div className="flex-1">
            <span className="text-xs font-mono uppercase tracking-wider text-brass-700 dark:text-brass-300 font-bold">
              Quick start
            </span>
            <h2 className="text-2xl sm:text-3xl font-semibold text-text-main tracking-tight mt-1 mb-3">
              Get started with one command
            </h2>
            <p className="text-sm text-text-muted mb-8 leading-relaxed">
              Launch the local server, open the web interface, and point your development tools to the gateway.
            </p>

            <div className="flex flex-col gap-4">
              {[
                { n: "1", title: "Run the binary", desc: "Execute npx 9router-kiyoshi to launch the gateway." },
                { n: "2", title: "Configure providers", desc: "Add API keys or configure OAuth in the dashboard." },
                { n: "3", title: "Route traffic", desc: "Set your tool base URL to http://localhost:20128/v1." },
              ].map((step) => (
                <div key={step.n} className="flex gap-3.5 items-start">
                  <div className="flex-none size-7 rounded-full bg-surface-2 text-text-main text-xs font-mono font-bold flex items-center justify-center shrink-0">
                    {step.n}
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-text-main">{step.title}</h3>
                    <p className="text-xs text-text-muted mt-0.5">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Code block */}
          <div className="flex-1 w-full min-w-0">
            <div className="rounded-card overflow-hidden bg-surface-2">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle text-xs text-text-muted font-mono">
                <span>terminal</span>
                <button
                  type="button"
                  onClick={() => handleCopy("npx 9router-kiyoshi")}
                  className="hover:text-text-main transition-colors cursor-pointer text-[11px]"
                >
                  {copied === "landing" ? "copied" : "copy"}
                </button>
              </div>

              <div className="p-4 sm:p-5 font-mono text-xs leading-relaxed overflow-x-auto text-text-main">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-brass-600 dark:text-brass-400 font-bold">$</span>
                  <span className="font-semibold">npx 9router-kiyoshi</span>
                </div>

                <div className="text-text-muted mb-4 space-y-1">
                  <div>&gt; Starting 9Router-Kiyoshi gateway...</div>
                  <div>&gt; Gateway listening on http://localhost:20128</div>
                  <div>&gt; Dashboard available at http://localhost:20128/dashboard</div>
                  <div className="text-brand-700 dark:text-brand-300 font-medium">&gt; Ready for requests</div>
                </div>

                <div className="text-[11px] text-text-subtle pt-3 border-t border-border-subtle">
                  Database: ~/.9router/db/data.sqlite
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
