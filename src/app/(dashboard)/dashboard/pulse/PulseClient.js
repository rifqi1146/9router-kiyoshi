"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { CardSkeleton } from "@/shared/components/Loading";
import { useProviderPulse } from "@/shared/hooks/useProviderPulse";
import { cn } from "@/shared/utils/cn";

const WINDOW_OPTIONS = [
  { value: "50", label: "50 req" },
  { value: "100", label: "100 req" },
  { value: "200", label: "200 req" },
  { value: "500", label: "500 req" },
];

const VIEW_TABS = [
  { value: "providers", label: "Per Provider", icon: "dns" },
  { value: "models", label: "Per Model", icon: "layers" },
  { value: "accounts", label: "Per Account / Key", icon: "key" },
  { value: "errors", label: "Recent Errors", icon: "error" },
];

const fmtNum = (n) => new Intl.NumberFormat().format(Math.round(Number(n) || 0));
// A dot as the thousands separator in locale id-ID reads like a decimal comma
// ("7.676ms" looks like 7.6ms), so put a space before the unit.
const fmtMs = (n) => (typeof n === "number" && n > 0 ? `${fmtNum(n)} ms` : "—");
const fmtRate = (n) => (typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(1)}%` : "0.0%");
// Timestamps in requestDetails are stored as UTC ISO strings; render in the
// browser's local timezone instead of slicing the UTC clock digits.
const fmtLocalTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

function HealthBadge({ health }) {
  const map = {
    healthy: {
      label: "Healthy",
      dot: "bg-emerald-400",
      cls: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10",
    },
    degraded: {
      label: "Degraded",
      dot: "bg-amber-400",
      cls: "text-amber-500 border-amber-500/40 bg-amber-500/10",
    },
    down: {
      label: "Down",
      dot: "bg-rose-400",
      cls: "text-rose-500 border-rose-500/40 bg-rose-500/10",
    },
    unknown: {
      label: "No Data",
      dot: "bg-text-muted",
      cls: "text-text-muted border-border bg-surface-2",
    },
  };
  const cfg = map[health] || map.unknown;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-chip text-[11px] font-medium border leading-none whitespace-nowrap",
        cfg.cls
      )}
    >
      <span className={cn("size-1.5 rounded-full shrink-0", cfg.dot)} aria-hidden="true" />
      {cfg.label}
    </span>
  );
}

function HttpStatusBadge({ code, count }) {
  const numeric = typeof code === "number" ? code : Number(code);
  const isUnknown = code === "unknown" || code === null || code === undefined || !Number.isFinite(numeric);
  const is2xx = !isUnknown && numeric >= 200 && numeric < 300;
  const is4xx = !isUnknown && numeric >= 400 && numeric < 500;
  const is5xx = !isUnknown && numeric >= 500;

  const color = is2xx
    ? "text-emerald-500 border-emerald-500/40 bg-emerald-500/10"
    : is4xx
    ? "text-amber-500 border-amber-500/40 bg-amber-500/10"
    : is5xx
    ? "text-rose-500 border-rose-500/40 bg-rose-500/10"
    : "text-text-muted border-border bg-surface-2";

  const label = isUnknown ? "unknown" : String(numeric);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-chip text-[11px] font-mono border",
        color
      )}
      title={isUnknown
        ? `${count} request(s) have no stored HTTP status`
        : `${count} request(s) returned HTTP ${numeric}`}
    >
      <span className="font-semibold">{label}</span>
      <span className="text-[10px] opacity-75">×{count}</span>
    </span>
  );
}

export default function PulseClient() {
  const [windowSize, setWindowSize] = useState("200");
  const [activeTab, setActiveTab] = useState("providers");
  const [search, setSearch] = useState("");

  const { loaded, data, error, updatedAt, refresh } = useProviderPulse(Number(windowSize));

  const summary = useMemo(() => data?.summary || {}, [data]);
  const providers = useMemo(() => data?.providers || [], [data]);
  const models = useMemo(() => data?.models || [], [data]);
  const accounts = useMemo(() => data?.accounts || [], [data]);
  const recentErrors = useMemo(() => data?.recentErrors || [], [data]);
  const observabilityEnabled = data?.observabilityEnabled ?? true;
  const updatedAtLabel = updatedAt
    ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  // Filter items by search query
  const filteredItems = useMemo(() => {
    const list =
      activeTab === "providers"
        ? providers
        : activeTab === "models"
        ? models
        : activeTab === "accounts"
        ? accounts
        : [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((item) => item.key?.toLowerCase().includes(q));
  }, [activeTab, providers, models, accounts, search]);

  // Mini latency trend for chart
  const latencyChartData = useMemo(() => {
    return providers.map((p) => ({
      name: p.key.replace("openai-compatible-chat-", "compat-").slice(0, 16),
      p50: p.ttftP50 || 0,
      p95: p.ttftP95 || 0,
    }));
  }, [providers]);

  if (!loaded && !data) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Top Banner if Observability is Disabled */}
      {!observabilityEnabled && (
        <div className="rounded-card border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-text-main flex items-start gap-3">
          <span className="material-symbols-outlined text-amber-500 text-[22px] shrink-0">
            warning
          </span>
          <div className="flex-1">
            <p className="font-semibold text-amber-500">Observability database is disabled</p>
            <p className="text-xs text-text-muted mt-0.5">
              Request details are not being persisted to SQLite, so telemetry rows cannot be computed.
              Turn on <span className="font-mono text-text-main">Enable Observability</span> in{" "}
              <Link href="/dashboard/settings" className="underline hover:text-text-main">
                Settings → General
              </Link>{" "}
              to start collecting live metrics.
            </p>
          </div>
        </div>
      )}
      {/* Inline error banner if fetch failed */}
      {error && (
        <div className="rounded-card border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-text-main flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-rose-500">
            <span className="material-symbols-outlined text-[20px]">error</span>
            <span>{error}</span>
          </div>
          <Button variant="secondary" size="xs" onClick={refresh}>Retry</Button>
        </div>
      )}

      {/* Header controls: Title + Window selector + Refresh */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-control bg-surface-2 text-brass-600 dark:text-brass-300">
            <span className="material-symbols-outlined text-[22px]">vital_signs</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-text-main">Live Provider Pulse</h2>
              <HealthBadge health={summary.overallHealth || "unknown"} />
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              Live sample of the last {windowSize} requests ·{" "}
              {updatedAtLabel ? <span>updated at {updatedAtLabel}</span> : "polling"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <SegmentedControl
            options={WINDOW_OPTIONS}
            value={windowSize}
            onChange={setWindowSize}
            size="sm"
          />
          <Button variant="secondary" size="sm" onClick={refresh}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Overview Cards */}
      <div className="grid min-w-0 grid-cols-2 lg:grid-cols-5 gap-2.5 sm:gap-4">
        <Card className="flex min-w-0 flex-col items-center justify-start text-center gap-1 px-2 py-3 sm:px-2.5 sm:py-4">
          <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">
            Sample Requests
          </span>
          <span
            className="w-full font-mono text-lg min-[1440px]:text-xl font-bold tabular-nums tracking-[-0.045em] whitespace-nowrap leading-tight text-text-main"
            title={fmtNum(summary.totalRequests)}
          >
            {fmtNum(summary.totalRequests)}
          </span>
          <span className="text-[10px] text-text-subtle">
            in window ({windowSize} max)
          </span>
        </Card>

        <Card className="flex min-w-0 flex-col items-center justify-start text-center gap-1 px-2 py-3 sm:px-2.5 sm:py-4">
          <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">
            Success Rate
          </span>
          <span
            className={cn(
              "w-full font-mono text-lg min-[1440px]:text-xl font-bold tabular-nums tracking-[-0.045em] whitespace-nowrap leading-tight",
              summary.successRate >= 90
                ? "text-emerald-500"
                : summary.successRate >= 70
                ? "text-amber-500"
                : "text-rose-500"
            )}
            title={`${summary.successRate}%`}
          >
            {fmtRate(summary.successRate)}
          </span>
          <span className="text-[10px] text-text-subtle">
            {fmtNum(summary.successCount)} ok / {fmtNum(summary.errorCount)} err
          </span>
        </Card>

        <Card className="flex min-w-0 flex-col items-center justify-start text-center gap-1 px-2 py-3 sm:px-2.5 sm:py-4">
          <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">
            Active Providers
          </span>
          <span className="w-full font-mono text-lg min-[1440px]:text-xl font-bold tabular-nums tracking-[-0.045em] whitespace-nowrap leading-tight text-brand-700 dark:text-brand-300">
            {summary.activeProvidersCount || 0}
          </span>
          <span className="text-[10px] text-text-subtle">
            routed in window
          </span>
        </Card>

        <Card className="flex min-w-0 flex-col items-center justify-start text-center gap-1 px-2 py-3 sm:px-2.5 sm:py-4">
          <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">
            Active Models
          </span>
          <span className="w-full font-mono text-lg min-[1440px]:text-xl font-bold tabular-nums tracking-[-0.045em] whitespace-nowrap leading-tight text-brass-700 dark:text-brass-300">
            {summary.activeModelsCount || 0}
          </span>
          <span className="text-[10px] text-text-subtle">
            flavors observed
          </span>
        </Card>

        <Card className="flex min-w-0 flex-col items-center justify-start text-center gap-1 px-2 py-3 sm:px-2.5 sm:py-4">
          <span className="text-text-muted text-[11px] uppercase font-semibold sm:text-xs">
            Active Accounts
          </span>
          <span className="w-full font-mono text-lg min-[1440px]:text-xl font-bold tabular-nums tracking-[-0.045em] whitespace-nowrap leading-tight text-brand-600 dark:text-brand-400">
            {summary.activeAccountsCount || 0}
          </span>
          <span className="text-[10px] text-text-subtle">
            keys / credentials
          </span>
        </Card>
      </div>

      {/* HTTP Status Code Distribution Bar */}
      {summary.httpStatusDistribution && Object.keys(summary.httpStatusDistribution).length > 0 && (
        <Card title="HTTP Status Distribution" icon="http" padding="sm">
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {Object.entries(summary.httpStatusDistribution).map(([code, count]) => (
              <HttpStatusBadge key={code} code={code} count={count} />
            ))}
          </div>
        </Card>
      )}

      {/* Navigation tabs for Per Provider / Per Model / Per Account / Recent Errors */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <SegmentedControl
          options={VIEW_TABS}
          value={activeTab}
          onChange={setActiveTab}
          className="w-full sm:w-auto"
        />

        {activeTab !== "errors" && (
          <div className="relative w-full sm:w-64">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">
              search
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Filter ${activeTab}...`}
              className="w-full rounded-control border border-border bg-surface-2 pl-9 pr-3 py-1.5 text-xs text-text-main placeholder:text-text-muted focus:border-brand-500 focus:outline-none transition-colors"
            />
          </div>
        )}
      </div>

      {/* Main Table for Providers / Models / Accounts */}
      {activeTab !== "errors" && (
        <Card className="overflow-hidden" padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2 text-text-muted text-xs">
                <tr>
                  <th className="px-4 sm:px-6 py-3 font-semibold">
                    {activeTab === "providers"
                      ? "Provider"
                      : activeTab === "models"
                      ? "Model"
                      : "Account / Key"}
                  </th>
                  <th className="px-4 sm:px-6 py-3 text-center font-semibold">Health</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">Requests</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">Success %</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">TTFT p50</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">TTFT p95</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">Total p50</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">Cache Hit %</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">Tokens (In / Out)</th>
                  <th className="px-4 sm:px-6 py-3 text-right font-semibold">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-center py-8 text-text-muted">
                      <span className="material-symbols-outlined text-[40px] opacity-30">
                        search_off
                      </span>
                      <p className="text-xs mt-1">No matching entries found</p>
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((row) => (
                    <tr key={row.key} className="hover:bg-surface-2 transition-colors">
                      <td className="px-4 sm:px-6 py-3 font-medium text-text-main font-mono text-xs">
                        {row.key}
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-center">
                        <HealthBadge health={row.health} />
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-xs text-text-main">
                        {fmtNum(row.total)}
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-xs">
                        <span
                          className={cn(
                            row.successRate >= 90
                              ? "text-emerald-500 font-semibold"
                              : row.successRate >= 70
                              ? "text-amber-500 font-semibold"
                              : "text-rose-500 font-semibold"
                          )}
                        >
                          {fmtRate(row.successRate)}
                        </span>
                        <span className="text-[10px] text-text-subtle ml-1">
                          ({row.success}/{row.total})
                        </span>
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-xs text-text-main">
                        {fmtMs(row.ttftP50)}
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-xs text-text-muted">
                        {fmtMs(row.ttftP95)}
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-xs text-text-muted">
                        {fmtMs(row.totalP50)}
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-xs">
                        <span
                          className={cn(
                            row.cacheHitRate >= 80
                              ? "text-brand-600 dark:text-brand-400 font-semibold"
                              : "text-text-muted"
                          )}
                        >
                          {fmtRate(row.cacheHitRate)}
                        </span>
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-[11px] text-text-subtle">
                        {fmtNum(row.inTok)} / {fmtNum(row.outTok)}
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-right font-mono text-[11px] text-text-subtle">
                        {fmtLocalTime(row.lastSeen)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Recent Errors Tab */}
      {activeTab === "errors" && (
        <Card className="overflow-hidden" padding="none">
          <div className="p-4 border-b border-border bg-surface-2 flex items-center justify-between">
            <h3 className="font-semibold text-text-main text-sm flex items-center gap-2">
              <span className="material-symbols-outlined text-rose-500 text-[18px]">error</span>
              Recent Upstream Failures ({recentErrors.length})
            </h3>
            <span className="text-xs text-text-muted">Decoded from response data</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2 text-text-muted text-xs">
                <tr>
                  <th className="px-4 sm:px-6 py-3 font-semibold">Time</th>
                  <th className="px-4 sm:px-6 py-3 font-semibold">Provider / Model</th>
                  <th className="px-4 sm:px-6 py-3 font-semibold">Account</th>
                  <th className="px-4 sm:px-6 py-3 font-semibold">HTTP Code</th>
                  <th className="px-4 sm:px-6 py-3 font-semibold">Error Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {recentErrors.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-10 text-text-muted">
                      <span className="material-symbols-outlined text-[48px] text-emerald-500 opacity-60">
                        check_circle
                      </span>
                      <p className="text-sm font-semibold text-text-main mt-2">
                        Zero errors in current window
                      </p>
                      <p className="text-xs text-text-subtle mt-0.5">
                        All {summary.totalRequests} sample requests completed successfully.
                      </p>
                    </td>
                  </tr>
                ) : (
                  recentErrors.map((err) => (
                    <tr key={err.id} className="hover:bg-surface-2 transition-colors">
                      <td className="px-4 sm:px-6 py-3 font-mono text-xs text-text-subtle whitespace-nowrap">
                        {fmtLocalTime(err.timestamp)}
                      </td>
                      <td className="px-4 sm:px-6 py-3 font-mono text-xs text-text-main">
                        <div className="font-semibold">{err.provider}</div>
                        <div className="text-[11px] text-text-muted">{err.model}</div>
                      </td>
                      <td className="px-4 sm:px-6 py-3 font-mono text-xs text-text-muted">
                        {err.accountLabel}
                      </td>
                      <td className="px-4 sm:px-6 py-3">
                        <HttpStatusBadge code={err.httpStatus} count={1} />
                      </td>
                      <td className="px-4 sm:px-6 py-3 font-mono text-xs text-rose-500 dark:text-rose-400 break-all max-w-md">
                        {err.errorMessage}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Latency Comparison Card with Recharts */}
      {latencyChartData.length > 0 && activeTab === "providers" && (
        <Card title="Provider TTFT Latency (p50 vs p95)" icon="speed" padding="md">
          <div className="h-48 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={latencyChartData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="p50Grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="p95Grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.6 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `${v}ms`}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--color-bg)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value, name) => [
                    `${fmtNum(value)}ms`,
                    name === "p50" ? "TTFT p50" : "TTFT p95",
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="p50"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#p50Grad)"
                />
                <Area
                  type="monotone"
                  dataKey="p95"
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  fill="url(#p95Grad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center justify-end gap-4 text-[11px] text-text-muted mt-2">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-emerald-500" />
              p50 (median)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-amber-500" />
              p95 (tail latency)
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
