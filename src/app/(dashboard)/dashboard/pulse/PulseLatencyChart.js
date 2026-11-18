"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";

export default function PulseLatencyChart({ data, fmtNum }) {
  return (
    <Card title="Provider TTFT Latency (p50 vs p95)" icon="speed" padding="md">
      <div className="h-48 w-full pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="p50Grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#4E8059" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#4E8059" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="p95Grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#C9AC80" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#C9AC80" stopOpacity={0} />
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
              stroke="#4E8059"
              strokeWidth={2}
              fill="url(#p50Grad)"
            />
            <Area
              type="monotone"
              dataKey="p95"
              stroke="#C9AC80"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              fill="url(#p95Grad)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center justify-end gap-4 text-[11px] text-text-muted mt-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-brand-700" />
          p50 (median)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-brass-500" />
          p95 (tail latency)
        </span>
      </div>
    </Card>
  );
}
