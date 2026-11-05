"use client";

export default function HowItWorks() {
  const steps = [
    {
      num: "01",
      icon: "terminal",
      title: "Client configuration",
      desc: "Point Claude Code, Codex, or your app's OpenAI base URL to http://localhost:20128/v1.",
    },
    {
      num: "02",
      icon: "hub",
      title: "Local gateway",
      desc: "9Router-Kiyoshi intercepts requests, validates API key quotas, and injects configured prompt presets.",
    },
    {
      num: "03",
      icon: "dns",
      title: "Provider dispatch",
      desc: "Dispatches upstream with automated fallback across available models and provider pools.",
    },
  ];

  return (
    <section className="py-16 sm:py-20 px-4 sm:px-6 border-y border-border-subtle bg-surface/30" id="how-it-works">
      <div className="max-w-7xl mx-auto">
        <div className="mb-10 sm:mb-12">
          <span className="text-xs font-mono uppercase tracking-wider text-brass-700 dark:text-brass-300 font-bold">
            Architecture
          </span>
          <h2 className="text-2xl sm:text-3xl font-semibold text-text-main tracking-tight mt-1">
            How requests route through the gateway
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {steps.map((s) => (
            <div
              key={s.num}
              className="p-5 rounded-card bg-surface flex flex-col gap-4"
            >
              <div className="flex items-center justify-between">
                <div className="size-9 rounded-control bg-surface-2 text-brass-600 dark:text-brass-300 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                    {s.icon}
                  </span>
                </div>
                <span className="text-xs font-mono font-semibold text-text-subtle">
                  {s.num}
                </span>
              </div>
              <div>
                <h3 className="text-base font-semibold text-text-main mb-1">
                  {s.title}
                </h3>
                <p className="text-xs text-text-muted leading-relaxed">
                  {s.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
