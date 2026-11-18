"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { StaggerGrid, StaggerItem, AnimatedNumber } from "@/shared/components/motion/KiyoshiMotion";
const fmt = (n) => new Intl.NumberFormat().format(Math.round(Number(n) || 0));
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

const VALUE_CLASS =
  "w-full font-mono text-lg min-[1440px]:text-xl font-bold tabular-nums tracking-[-0.045em] whitespace-nowrap leading-tight";

export default function OverviewCards({ stats }) {
  const cards = [
    {
      label: "Total Requests",
      raw: stats.totalRequests || 0,
      format: fmt,
      value: fmt(stats.totalRequests),
      className: "text-text-main",
      sub: null,
    },
    {
      label: "Input Tokens",
      raw: stats.totalPromptTokens || 0,
      format: fmt,
      value: fmt(stats.totalPromptTokens),
      className: "text-brass-700 dark:text-brass-300",
      sub: null,
    },
    {
      label: "Cached Tokens",
      raw: stats.totalCachedTokens || 0,
      format: fmt,
      value: fmt(stats.totalCachedTokens),
      className: "text-brand-700 dark:text-brand-300",
      sub: null,
    },
    {
      label: "Output Tokens",
      raw: stats.totalCompletionTokens || 0,
      format: fmt,
      value: fmt(stats.totalCompletionTokens),
      className: "text-brand-600 dark:text-brand-400",
      sub: null,
    },
    {
      label: "Est. Cost",
      raw: stats.totalCost || 0,
      format: (n) => `~${fmtCost(n)}`,
      value: `~${fmtCost(stats.totalCost)}`,
      className: "text-brass-600 dark:text-brass-400",
      sub: "Estimated, not billing",
    },
  ];

  return (
    <StaggerGrid className="grid min-w-0 grid-cols-2 lg:grid-cols-5 gap-2.5 sm:gap-4">
      {cards.map((c, i) => (
        <StaggerItem
          key={c.label}
          className={i === cards.length - 1 ? "col-span-2 lg:col-span-1" : ""}
        >
          <Card
            hover
            className="h-full flex min-w-0 flex-col items-center justify-start text-center gap-1 px-2 py-3 sm:px-2.5 sm:py-4"
          >
            <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">
              {c.label}
            </span>
            <span
              className={`${VALUE_CLASS} ${c.className}`}
              title={c.value}
            >
              <AnimatedNumber value={c.raw} format={c.format} />
            </span>
            {c.sub ? (
              <span className="text-[10px] text-text-subtle">{c.sub}</span>
            ) : (
              <span className="text-[10px] text-transparent select-none" aria-hidden="true">&nbsp;</span>
            )}
          </Card>
        </StaggerItem>
      ))}
    </StaggerGrid>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
