"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-2 lg:grid-cols-5 gap-2.5 sm:gap-4">
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 p-3 sm:p-4">
        <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">Total Requests</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-text-main" title={fmt(stats.totalRequests)}>{fmt(stats.totalRequests)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 p-3 sm:p-4">
        <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">Input Tokens</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-brass-700 dark:text-brass-300" title={fmt(stats.totalPromptTokens)}>{fmt(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 p-3 sm:p-4">
        <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">Cached Tokens</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-brand-700 dark:text-brand-300" title={fmt(stats.totalCachedTokens)}>{fmt(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 p-3 sm:p-4">
        <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">Output Tokens</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-brand-600 dark:text-brand-400" title={fmt(stats.totalCompletionTokens)}>{fmt(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="col-span-2 lg:col-span-1 flex min-w-0 flex-col items-center text-center gap-1 p-3 sm:p-4">
        <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">Est. Cost</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-brass-600 dark:text-brass-400" title={`~${fmtCost(stats.totalCost)}`}>~{fmtCost(stats.totalCost)}</span>
        <span className="text-[10px] text-text-subtle">Estimated, not billing</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
