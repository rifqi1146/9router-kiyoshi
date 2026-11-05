"use client";

const FEATURES = [
  {
    icon: "link",
    title: "Unified Endpoint",
    desc: "Access all providers via a single OpenAI/Anthropic compatible endpoint.",
  },
  {
    icon: "layers",
    title: "Model Fallback",
    desc: "Route automatically to backup providers on rate limit or downtime.",
  },
  {
    icon: "monitoring",
    title: "Usage Tracking",
    desc: "Track requests, token consumption, and latency across providers.",
  },
  {
    icon: "vpn_key",
    title: "Access Keys",
    desc: "Issue scoped API keys with token quotas, reset periods, and model whitelists.",
  },
  {
    icon: "terminal",
    title: "Tool Integration",
    desc: "Works with Claude Code, Codex, Cline, Cursor, and any OpenAI SDK client.",
  },
  {
    icon: "security",
    title: "Prompt Presets",
    desc: "Built-in red-team and development prompt injection layers.",
  },
  {
    icon: "compress",
    title: "Token Saver",
    desc: "Context compression to reduce input token costs on long sessions.",
  },
  {
    icon: "dns",
    title: "Local Database",
    desc: "All usage logs and keys stored locally in ~/.9router/db/data.sqlite.",
  },
];

export default function Features() {
  return (
    <section className="py-16 sm:py-20 px-4 sm:px-6" id="features">
      <div className="max-w-7xl mx-auto">
        <div className="mb-10 sm:mb-12">
          <span className="text-xs font-mono uppercase tracking-wider text-brass-700 dark:text-brass-300 font-bold">
            Capabilities
          </span>
          <h2 className="text-2xl sm:text-3xl font-semibold text-text-main tracking-tight mt-1">
            Built for local AI development
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="p-5 rounded-card bg-surface transition-colors hover:bg-surface-2 group"
            >
              <div className="size-9 rounded-control bg-surface-2 text-brass-600 dark:text-brass-300 flex items-center justify-center mb-3.5">
                <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
                  {feature.icon}
                </span>
              </div>
              <h3 className="text-base font-semibold text-text-main mb-1.5 leading-tight">
                {feature.title}
              </h3>
              <p className="text-xs text-text-muted leading-relaxed">
                {feature.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
