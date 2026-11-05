"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, CardSkeleton } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtUptime(sec) {
  if (!sec || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function getUsageColors(usedPercentage) {
  if (usedPercentage >= 90) {
    return {
      text: "text-clay-500",
      bg: "bg-clay-500",
      bgLight: "bg-surface-2",
      badge: "bg-clay-500 text-white",
    };
  }
  if (usedPercentage >= 70) {
    return {
      text: "text-brass-600 dark:text-brass-300",
      bg: "bg-brass-500",
      bgLight: "bg-surface-2",
      badge: "bg-brass-500 text-white",
    };
  }
  return {
    text: "text-brand-700 dark:text-brand-300",
    bg: "bg-brand-700 dark:bg-brand-500",
    bgLight: "bg-surface-2",
    badge: "bg-brand-700 text-white",
  };
}

function MetricProgress({ label, usedFormatted, totalFormatted, percentage, subtitle }) {
  const colors = getUsageColors(percentage);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-text-primary">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">
            {usedFormatted} / {totalFormatted}
          </span>
          <span className={cn("font-medium font-mono text-xs", colors.text)}>
            ({percentage}%)
          </span>
        </div>
      </div>
      <div className={cn("h-2 rounded-full overflow-hidden", colors.bgLight)}>
        <div
          className={cn("h-full transition-all duration-300", colors.bg)}
          style={{ width: `${Math.min(Math.max(percentage, 0), 100)}%` }}
        />
      </div>
      {subtitle && <p className="text-xs text-text-muted">{subtitle}</p>}
    </div>
  );
}

function DataRow({ label, value, mono = false, copyable = false }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!copyable || !value) return;
    navigator.clipboard?.writeText(String(value));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-border-subtle last:border-b-0 text-sm">
      <span className="text-xs text-text-muted">{label}</span>
      <span
        onClick={handleCopy}
        className={cn(
          "text-text-main text-right break-all",
          mono && "font-mono text-xs",
          copyable && "cursor-pointer hover:underline"
        )}
        title={copyable ? "Click to copy" : undefined}
      >
        {value ?? "—"}
        {copied && <span className="ml-1.5 text-xs text-green-500">copied</span>}
      </span>
    </div>
  );
}

export default function OverviewClient() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/overview/specs", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setErr(null);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [auto, load]);

  if (loading) {
    return <CardSkeleton count={3} />;
  }

  if (err) {
    return (
      <Card title="Server Overview" icon="error">
        <p className="text-sm text-red-500 mb-4">Failed to read server specifications: {err}</p>
        <Button onClick={load}>Retry</Button>
      </Card>
    );
  }

  const { host, cpu, memory, disk, thermal, network, ports, services, tailscale, cloudflared, packages, sessions, process: proc } = data;

  return (
    <div className="space-y-6">
      {/* Header matching dashboard conventions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-control bg-surface-2 text-brass-600 dark:text-brass-300">
            <span className="material-symbols-outlined text-[22px]">monitoring</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-text-main">{host.hostname}</h2>
              <span className="inline-flex items-center gap-1.5 rounded-chip bg-brand-700 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white">
                <span className="size-1.5 rounded-full bg-brand-200" />
                online
              </span>
            </div>
            <p className="text-sm text-text-muted">
              {host.osRelease?.pretty || host.platform} · Linux {host.kernel} · {host.arch}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className="accent-primary"
            />
            Auto-refresh 5s
          </label>
          <Button variant="secondary" onClick={load}>
            <span className="material-symbols-outlined text-sm">refresh</span>
            Refresh
          </Button>
        </div>
      </div>

      {/* Primary vitals cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card title="System Uptime" icon="schedule" padding="sm">
          <div className="text-xl font-bold text-text-main font-mono">{fmtUptime(host.uptimeSec)}</div>
          <p className="text-xs text-text-muted mt-1">Booted {host.bootedAt || "—"}</p>
        </Card>

        <Card title="CPU Load" icon="memory" padding="sm">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-text-main font-mono">{cpu.load.one}</span>
            <span className="text-xs text-text-muted font-mono">/ {cpu.cores} cores</span>
          </div>
          <p className="text-xs text-text-muted mt-1">
            5m: {cpu.load.five} · 15m: {cpu.load.fifteen} ({cpu.loadPct}%)
          </p>
        </Card>

        <Card title="Physical Memory" icon="pie_chart" padding="sm">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-text-main font-mono">{memory.usedPct}%</span>
            <span className="text-xs text-text-muted">used</span>
          </div>
          <p className="text-xs text-text-muted mt-1">
            {fmtBytes(memory.availableBytes)} available of {fmtBytes(memory.totalBytes)}
          </p>
        </Card>

        <Card title="Root Storage" icon="hard_drive" padding="sm">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-text-main font-mono">{disk.usedPct}%</span>
            <span className="text-xs text-text-muted">used</span>
          </div>
          <p className="text-xs text-text-muted mt-1">
            {fmtBytes(disk.availableBytes)} free of {fmtBytes(disk.totalBytes)}
          </p>
        </Card>
      </div>

      {/* Main sections grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hardware & Platform Card */}
        <Card title="Host & Architecture" icon="dns">
          <div className="space-y-1">
            <DataRow label="Hostname" value={host.hostname} mono copyable />
            <DataRow label="Operating System" value={host.osRelease?.pretty} />
            <DataRow label="Version Codename" value={host.osRelease?.codename} />
            <DataRow label="Linux Kernel" value={host.kernel} mono />
            <DataRow label="Platform / Arch" value={`${host.platform} / ${host.arch}`} />
            <DataRow label="Virtualization" value={host.virtualization} />
            <DataRow label="Timezone" value={host.timezone} />
            <DataRow label="Node.js Runtime" value={host.nodeVersion} mono />
            <DataRow label="Installed Packages" value={`apt: ${packages.apt} · npm global: ${packages.npmGlobal}`} />
          </div>
        </Card>

        {/* Processor Details Card */}
        <Card title="Processor Specifications" icon="developer_board">
          <div className="space-y-1">
            <DataRow label="Processor Model" value={cpu.model} />
            <DataRow label="Logical Cores" value={`${cpu.cores} threads`} />
            <DataRow label="Base Frequency" value={cpu.speedMhz ? `${cpu.speedMhz} MHz` : "—"} />
            <DataRow label="L3 / CPU Cache" value={cpu.cache || "—"} />
            <DataRow label="Microcode Version" value={cpu.microcode || "—"} mono />
          </div>

          <div className="mt-4 pt-3 border-t border-border-subtle">
            <MetricProgress
              label="CPU Utilization (1 min)"
              usedFormatted={`${cpu.load.one}`}
              totalFormatted={`${cpu.cores} cores`}
              percentage={Math.round(cpu.loadPct)}
              subtitle={`Load averages: 1m=${cpu.load.one} · 5m=${cpu.load.five} · 15m=${cpu.load.fifteen}`}
            />
          </div>

          {thermal && thermal.length > 0 && (
            <div className="mt-4 pt-3 border-t border-border-subtle">
              <span className="text-xs font-semibold text-text-primary block mb-2">Thermals</span>
              <div className="space-y-1">
                {thermal.map((t, idx) => (
                  <DataRow key={idx} label={t.zone} value={`${t.celsius} °C`} mono />
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Memory & Storage Card */}
        <Card title="Memory & Storage Allocation" icon="storage">
          <div className="space-y-5">
            <MetricProgress
              label="Physical RAM"
              usedFormatted={fmtBytes(memory.usedBytes)}
              totalFormatted={fmtBytes(memory.totalBytes)}
              percentage={Math.round(memory.usedPct)}
              subtitle={`${fmtBytes(memory.availableBytes)} available without swap`}
            />

            {memory.swapTotalBytes > 0 && (
              <MetricProgress
                label="Swap Space"
                usedFormatted={fmtBytes(memory.swapUsedBytes)}
                totalFormatted={fmtBytes(memory.swapTotalBytes)}
                percentage={Math.round(memory.swapPct)}
                subtitle={`${fmtBytes(memory.swapTotalBytes - memory.swapUsedBytes)} free`}
              />
            )}

            <MetricProgress
              label={`Root Filesystem (${disk.mount})`}
              usedFormatted={fmtBytes(disk.usedBytes)}
              totalFormatted={fmtBytes(disk.totalBytes)}
              percentage={Math.round(disk.usedPct)}
              subtitle={`${fmtBytes(disk.availableBytes)} free storage`}
            />
          </div>

          <div className="mt-4 pt-3 border-t border-border-subtle">
            <span className="text-xs font-semibold text-text-primary block mb-2">9Router Process Footprint</span>
            <div className="space-y-1">
              <DataRow label="Process ID" value={proc.pid} mono />
              <DataRow label="Process Uptime" value={fmtUptime(proc.uptimeSec)} />
              <DataRow label="Resident Memory (RSS)" value={fmtBytes(proc.memoryRssBytes)} mono />
              <DataRow label="V8 Heap Used" value={fmtBytes(proc.heapUsedBytes)} mono />
              <DataRow label="V8 Heap Total" value={fmtBytes(proc.heapTotalBytes)} mono />
            </div>
          </div>
        </Card>

        {/* Network & Ingress Card */}
        <Card title="Network & Ingress Interfaces" icon="lan">
          <div className="space-y-1">
            {network.length === 0 ? (
              <p className="text-sm text-text-muted py-2">No external network interfaces detected.</p>
            ) : (
              network.map((n, i) => (
                <DataRow
                  key={i}
                  label={`${n.interface} (${n.family})`}
                  value={n.address}
                  mono
                  copyable
                />
              ))
            )}

            {tailscale && (
              <div className="pt-2 border-t border-border-subtle">
                <DataRow label="Tailscale IPv4" value={tailscale.ip} mono copyable />
                {tailscale.hostname && <DataRow label="Tailscale Node" value={tailscale.hostname} mono />}
              </div>
            )}

            {cloudflared && (
              <div className="pt-2 border-t border-border-subtle">
                <DataRow
                  label="Cloudflare Tunnel"
                  value={`Active (${cloudflared.pids.length} worker processes)`}
                />
              </div>
            )}

            {services.map((s) => (
              <DataRow
                key={s.name}
                label={`Service: ${s.name}`}
                value={`${s.active} · ${s.enabled}`}
              />
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border-subtle">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-text-primary">
                Listening TCP Services ({ports.length})
              </span>
              <div className="flex gap-3 text-[11px] text-text-muted">
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Local
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                  Public
                </span>
              </div>
            </div>

            <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
              {ports.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-xs py-1 border-b border-border-subtle last:border-b-0"
                >
                  <div className="flex items-center gap-2 font-mono">
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        p.public ? "bg-yellow-500" : "bg-green-500"
                      )}
                    />
                    <span className="font-semibold text-text-main">:{p.port}</span>
                    <span className="text-text-muted text-[11px]">{p.address}</span>
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-text-main">{p.process}</span>
                    {p.pid && <span className="text-text-muted text-[10px] ml-1">({p.pid})</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Footer login sessions summary */}
      <Card padding="sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-text-muted">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">account_circle</span>
            <span>
              Active Sessions:{" "}
              {sessions.length === 0
                ? "none"
                : sessions.map((s) => `${s.user} (${s.tty})`).join(", ")}
            </span>
          </div>
          <div>
            Snapshot: {new Date(data.timestamp).toLocaleTimeString()} · 9Router v0.6.4
          </div>
        </div>
      </Card>
    </div>
  );
}
