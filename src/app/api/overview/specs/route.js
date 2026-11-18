import { NextResponse } from "next/server";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

let staticHostCache = null;
let packagesCache = { value: null, ts: 0 };

async function safeExec(cmd, timeout = 2500) {
  try {
    const { stdout } = await execAsync(cmd, { encoding: "utf8", timeout });
    return (stdout || "").trim();
  } catch {
    return "";
  }
}

function readProcMeminfo() {
  try {
    const raw = fs.readFileSync("/proc/meminfo", "utf8");
    const get = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const total = get("MemTotal");
    const free = get("MemFree");
    const avail = get("MemAvailable");
    const buffers = get("Buffers");
    const cached = get("Cached");
    const swapTotal = get("SwapTotal");
    const swapFree = get("SwapFree");
    return {
      total,
      free,
      available: avail || free + buffers + cached,
      used: total - (avail || free + buffers + cached),
      swapTotal,
      swapFree,
      swapUsed: swapTotal - swapFree,
    };
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, free, available: free, used: total - free, swapTotal: 0, swapFree: 0, swapUsed: 0 };
  }
}

async function readDisk() {
  const out = await safeExec("df -B1 / 2>/dev/null");
  const lines = out.split("\n").filter(Boolean);
  if (lines.length >= 2) {
    const p = lines[1].split(/\s+/);
    const total = parseInt(p[1], 10) || 0;
    const used = parseInt(p[2], 10) || 0;
    const available = parseInt(p[3], 10) || 0;
    return { total, used, available, pct: total > 0 ? Math.round((used / total) * 100) : 0, mount: "/" };
  }
  return { total: 0, used: 0, available: 0, pct: 0, mount: "/" };
}

function readOsRelease() {
  try {
    const raw = fs.readFileSync("/etc/os-release", "utf8");
    const g = (k) => {
      const m = raw.match(new RegExp(`^${k}="?([^"\\n]+)"?`, "m"));
      return m ? m[1] : "";
    };
    return {
      pretty: g("PRETTY_NAME") || `${os.type()} ${os.release()}`,
      name: g("NAME"),
      version: g("VERSION"),
      versionId: g("VERSION_ID"),
      codename: g("VERSION_CODENAME"),
      id: g("ID"),
    };
  } catch {
    return { pretty: `${os.type()} ${os.release()}`, name: "", version: "", versionId: "", codename: "", id: "" };
  }
}

function readCpuInfo() {
  try {
    const raw = fs.readFileSync("/proc/cpuinfo", "utf8");
    const blocks = raw.split(/\n\n+/).filter(Boolean);
    const first = blocks[0] || "";
    const g = (k) => {
      const m = first.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : "";
    };
    const cacheMatch = first.match(/^cache size\s*:\s*(.+)$/m);
    return {
      vendor: g("vendor_id"),
      family: g("cpu family"),
      modelId: g("model"),
      modelName: g("model name"),
      stepping: g("stepping"),
      microcode: g("microcode"),
      cache: cacheMatch ? cacheMatch[1] : "",
      flags: g("flags").split(/\s+/).filter(Boolean),
      logicalCpus: blocks.length,
    };
  } catch {
    return { vendor: "", family: "", modelId: "", modelName: "", stepping: "", microcode: "", cache: "", flags: [], logicalCpus: os.cpus().length };
  }
}

async function readTemperature() {
  const out = await safeExec("for z in /sys/class/thermal/thermal_zone*/temp; do [ -r \"$z\" ] && echo \"$z $(cat $z)\"; done");
  if (!out) return null;
  const zones = [];
  for (const line of out.split("\n")) {
    const [path, raw] = line.split(/\s+/);
    const milli = parseInt(raw, 10);
    if (!Number.isFinite(milli)) continue;
    let label = "thermal";
    try {
      label = fs.readFileSync(path.replace("/temp", "/type"), "utf8").trim() || "thermal";
    } catch {}
    zones.push({ zone: label, celsius: +(milli / 1000).toFixed(1) });
  }
  return zones.length ? zones : null;
}

async function readVirtualization() {
  const virt = await safeExec("systemd-detect-virt 2>/dev/null");
  if (virt && virt !== "none") return virt;
  try {
    const raw = fs.readFileSync("/proc/cpuinfo", "utf8");
    if (/\bhypervisor\b/.test(raw)) return "hypervisor (bare-metal host w/ nested flag)";
  } catch {}
  return "none (bare metal or undetected)";
}

function readNetwork() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.internal) continue;
      list.push({
        interface: name,
        family: a.family,
        address: a.address,
        netmask: a.netmask,
        mac: a.mac,
      });
    }
  }
  return list;
}

async function readListeningPorts() {
  const out = await safeExec("ss -ltnpH 2>/dev/null");
  if (!out) return [];
  const rows = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[3];
    const proc = parts.slice(5).join(" ");
    const pidMatch = proc.match(/pid=(\d+)/);
    const nameMatch = proc.match(/\(\("([^"]+)"/);
    const idx = local.lastIndexOf(":");
    if (idx < 0) continue;
    rows.push({
      address: local.slice(0, idx),
      port: parseInt(local.slice(idx + 1), 10) || 0,
      process: nameMatch ? nameMatch[1] : "?",
      pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
      public: !/^(127\.|\[::1\]|::1)/.test(local.slice(0, idx)),
    });
  }
  return rows.sort((a, b) => a.port - b.port);
}

async function readServiceState(name) {
  const [active, enabled] = await Promise.all([
    safeExec(`systemctl is-active ${name} 2>/dev/null`),
    safeExec(`systemctl is-enabled ${name} 2>/dev/null`),
  ]);
  return { name, active: active || "unknown", enabled: enabled || "unknown" };
}

async function readTailscale() {
  const [ip, status] = await Promise.all([
    safeExec("tailscale ip -4 2>/dev/null"),
    safeExec("tailscale status --json 2>/dev/null"),
  ]);
  if (!ip && !status) return null;
  let hostname = "";
  try {
    const j = JSON.parse(status);
    hostname = j?.Self?.HostName || "";
  } catch {}
  return { ip: ip || null, hostname };
}

async function readCloudflared() {
  const pids = await safeExec("pgrep -f cloudflared 2>/dev/null");
  if (!pids) return null;
  return { running: true, pids: pids.split("\n").map(Number).filter(Boolean) };
}

async function readPackageCounts() {
  if (packagesCache.value && Date.now() - packagesCache.ts < 60000) {
    return packagesCache.value;
  }
  const [apt, npmGlobal] = await Promise.all([
    safeExec("dpkg-query -f '${binary:Package}\\n' -W 2>/dev/null | wc -l"),
    safeExec("npm ls -g --depth=0 --parseable 2>/dev/null | wc -l"),
  ]);
  const val = {
    apt: parseInt(apt, 10) || 0,
    npmGlobal: Math.max(0, (parseInt(npmGlobal, 10) || 0) - 1),
  };
  packagesCache = { value: val, ts: Date.now() };
  return val;
}

function readLoad() {
  const load = os.loadavg();
  return { one: +load[0].toFixed(2), five: +load[1].toFixed(2), fifteen: +load[2].toFixed(2) };
}

async function readLoggedInUsers() {
  const out = await safeExec("who 2>/dev/null");
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((l) => {
    const p = l.split(/\s+/);
    return { user: p[0], tty: p[1], since: p.slice(2, 4).join(" ") };
  });
}

async function readLastBoot() {
  const up = await safeExec("uptime -s 2>/dev/null");
  return up || null;
}

async function getStaticHostInfo() {
  if (staticHostCache) return staticHostCache;
  const [bootedAt, virtualization] = await Promise.all([
    readLastBoot(),
    readVirtualization(),
  ]);
  staticHostCache = {
    osRelease: readOsRelease(),
    cpuInfo: readCpuInfo(),
    bootedAt,
    virtualization,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  return staticHostCache;
}

export async function GET() {
  const cpus = os.cpus() || [];
  const mem = readProcMeminfo();
  const load = readLoad();

  const [
    staticInfo,
    disk,
    thermal,
    ports,
    svcCloudflared,
    svcNginx,
    svcTailscaled,
    tailscale,
    cloudflared,
    packages,
    sessions,
  ] = await Promise.all([
    getStaticHostInfo(),
    readDisk(),
    readTemperature(),
    readListeningPorts(),
    readServiceState("cloudflared"),
    readServiceState("nginx"),
    readServiceState("tailscaled"),
    readTailscale(),
    readCloudflared(),
    readPackageCounts(),
    readLoggedInUsers(),
  ]);

  const { osRelease: osr, cpuInfo, bootedAt, virtualization, timezone } = staticInfo;

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      osRelease: osr,
      kernel: os.release(),
      uptimeSec: Math.floor(os.uptime()),
      bootedAt,
      nodeVersion: process.version,
      virtualization,
      timezone,
    },
    cpu: {
      model: cpuInfo.modelName || cpus[0]?.model || "Unknown CPU",
      vendor: cpuInfo.vendor,
      family: cpuInfo.family,
      modelId: cpuInfo.modelId,
      stepping: cpuInfo.stepping,
      microcode: cpuInfo.microcode,
      cache: cpuInfo.cache,
      cores: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      flags: cpuInfo.flags.slice(0, 40),
      flagCount: cpuInfo.flags.length,
      load,
      loadPct: +((load.one / Math.max(1, cpus.length)) * 100).toFixed(1),
    },
    memory: {
      totalBytes: mem.total,
      usedBytes: mem.used,
      availableBytes: mem.available,
      usedPct: mem.total > 0 ? +((mem.used / mem.total) * 100).toFixed(1) : 0,
      swapTotalBytes: mem.swapTotal,
      swapUsedBytes: mem.swapUsed,
      swapPct: mem.swapTotal > 0 ? +((mem.swapUsed / mem.swapTotal) * 100).toFixed(1) : 0,
    },
    disk: {
      totalBytes: disk.total,
      usedBytes: disk.used,
      availableBytes: disk.available,
      usedPct: disk.pct,
      mount: disk.mount,
    },
    thermal,
    network: readNetwork(),
    ports,
    services: [svcCloudflared, svcNginx, svcTailscaled].filter(
      (s) => s.active !== "unknown" || s.enabled !== "unknown"
    ),
    tailscale,
    cloudflared,
    packages,
    sessions,
    process: {
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      memoryRssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      heapTotalBytes: process.memoryUsage().heapTotal,
      externalBytes: process.memoryUsage().external,
    },
  });
}
