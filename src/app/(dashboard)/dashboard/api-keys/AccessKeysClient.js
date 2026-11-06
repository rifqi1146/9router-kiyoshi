"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Toggle, Button, ModelSelectModal } from "@/shared/components";

const fmt = (n) => new Intl.NumberFormat().format(Math.round(Number(n) || 0));

function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function maskKey(key) {
  if (!key) return "-";
  if (key.length <= 14) return key;
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}

function relativeTime(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function expiryInfo(expiresAt) {
  if (!expiresAt) return { label: "never expires", tone: "ok" };
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return { label: "never expires", tone: "ok" };
  const diff = t - Date.now();
  if (diff <= 0) return { label: "expired", tone: "bad" };
  const d = Math.floor(diff / 86_400_000);
  if (d >= 1) return { label: `expires in ${d}d`, tone: d <= 2 ? "warn" : "ok" };
  const h = Math.floor(diff / 3_600_000);
  if (h >= 1) return { label: `expires in ${h}h`, tone: "warn" };
  return { label: `expires in ${Math.max(1, Math.floor(diff / 60_000))}m`, tone: "warn" };
}

function statusOf(k) {
  if (k.expired) return { label: "expired", tone: "bad" };
  if (!k.isActive) return { label: "disabled", tone: "muted" };
  return { label: "active", tone: "ok" };
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-card bg-surface ${className}`}>
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text-main placeholder:text-text-subtle focus:border-border-strong focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-semibold text-text-main";

const EXPIRY_PRESETS = [
  { value: "never", label: "Never (unlimited)" },
  { value: "1d", label: "1 day" },
  { value: "2d", label: "2 days" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "custom", label: "Custom date" },
];

function expiryToValue(preset, custom) {
  if (preset === "never") return null;
  if (preset === "custom") return custom || null;
  return preset;
}

function detectPreset(expiresAt) {
  if (!expiresAt) return { preset: "never", custom: "" };
  return { preset: "custom", custom: expiresAt.slice(0, 10) };
}

/* ------------------------------------------------------------------ */
/* Key form (shared by create and edit)                                */
/* ------------------------------------------------------------------ */

function KeyForm({ initial, onSubmit, onCancel, submitLabel, busy }) {
  const [name, setName] = useState(initial?.name || "");
  const [quotaEnabled, setQuotaEnabled] = useState(Number(initial?.tokenLimit) > 0);
  const [tokenLimit, setTokenLimit] = useState(String(initial?.tokenLimit || ""));
  const [period, setPeriod] = useState(initial?.tokenResetPeriod || "total");
  const [preset, setPreset] = useState(() => detectPreset(initial?.expiresAt).preset);
  const [custom, setCustom] = useState(() => detectPreset(initial?.expiresAt).custom);
  const [injection, setInjection] = useState(initial?.injection !== false);
  const [restrict, setRestrict] = useState(!!initial?.access?.restricted);
  const [allow, setAllow] = useState(initial?.access?.allow || []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  const openPicker = async () => {
    setPickerOpen(true);
    try {
      const [p, a] = await Promise.all([fetch("/api/providers"), fetch("/api/models/alias")]);
      if (p.ok) setActiveProviders((await p.json()).connections || []);
      if (a.ok) setModelAliases((await a.json()).aliases || {});
    } catch (e) {
      console.log("picker load failed", e);
    }
  };

  const submit = () => {
    if (!name.trim()) return;
    const payload = {
      name: name.trim(),
      tokenLimit: quotaEnabled ? Number(tokenLimit) || 0 : 0,
      tokenResetPeriod: period,
      expiresAt: expiryToValue(preset, custom),
      access: { restricted: restrict, allow: restrict ? allow : [] },
      injection,
    };
    onSubmit(payload);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className={labelCls}>Key name</label>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. production-bot"
          autoFocus
        />
      </div>

      <div className="rounded-control bg-surface-2 p-3">
        <Toggle
          checked={injection}
          onChange={setInjection}
          label="Prompt injection"
          description="Use the global jailbreak payload and custom prompt for this key. Off sends requests exactly as the client wrote them."
        />
      </div>

      <div className="rounded-control bg-surface-2 p-3">
        <Toggle
          checked={quotaEnabled}
          onChange={setQuotaEnabled}
          label="Token quota"
          description="Reject requests with 429 once the quota is used up"
        />
        {quotaEnabled && (
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <label className={labelCls}>Max tokens</label>
              <input
                className={inputCls}
                type="number"
                min="1"
                value={tokenLimit}
                onChange={(e) => setTokenLimit(e.target.value)}
                placeholder="e.g. 1000000"
              />
            </div>
            <div>
              <label className={labelCls}>Reset period</label>
              <div className="flex gap-2">
                {[
                  { v: "total", l: "Lifetime total" },
                  { v: "daily", l: "Daily (00:00 UTC)" },
                ].map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setPeriod(o.v)}
                    className={`flex-1 rounded-control px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                      period === o.v
                        ? "bg-brand-800 text-white"
                        : "bg-surface text-text-muted hover:text-text-main"
                    }`}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div>
        <label className={labelCls}>Expiration</label>
        <select className={inputCls} value={preset} onChange={(e) => setPreset(e.target.value)}>
          {EXPIRY_PRESETS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {preset === "custom" && (
          <input
            className={`${inputCls} mt-2`}
            type="date"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
      </div>

      <div className="rounded-control bg-surface-2 p-3">
        <Toggle
          checked={restrict}
          onChange={(v) => {
            setRestrict(v);
            if (v && allow.length === 0) openPicker();
          }}
          label="Restrict models"
          description="When on, this key may only call the listed combos and models"
        />
        {restrict && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {allow.length === 0 && (
              <span className="text-xs text-brass-600 dark:text-brass-300">
                No combos or models allowed, this key can call nothing.
              </span>
            )}
            {allow.map((entry) => (
              <span
                key={entry}
                className="flex items-center gap-1 rounded-chip bg-surface px-2 py-0.5 font-mono text-xs text-text-main"
              >
                {entry}
                <button
                  type="button"
                  onClick={() => setAllow(allow.filter((e) => e !== entry))}
                  className="rounded text-text-muted hover:text-clay-500 cursor-pointer"
                  aria-label={`Remove ${entry}`}
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>
                    close
                  </span>
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={openPicker}
              className="flex items-center gap-0.5 rounded-chip bg-surface px-2 py-1 text-xs font-semibold text-brass-700 dark:text-brass-300 hover:bg-surface-3 cursor-pointer"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>
                add
              </span>
              Add combo or model
            </button>
          </div>
        )}
      </div>

      <div className="mt-1 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} loading={busy} disabled={!name.trim()}>
          {submitLabel}
        </Button>
      </div>

      {pickerOpen && (
        <ModelSelectModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(m) => {
            const v = m?.value;
            if (v && !allow.some((e) => e.toLowerCase() === v.toLowerCase())) setAllow([...allow, v]);
          }}
          onDeselect={(m) => {
            const v = String(m?.value || "").toLowerCase();
            setAllow(allow.filter((e) => e.toLowerCase() !== v));
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Allowed combos and models"
          addedModelValues={allow}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

function KeyRow({ item, onToggle, onEdit, onDelete, onCopy, copied }) {
  const usage = item.usage || {};
  const status = statusOf(item);
  const expiry = expiryInfo(item.expiresAt);
  const limit = Number(item.tokenLimit) || 0;
  const used = item.tokenResetPeriod === "daily" ? usage.dailyTokens || 0 : usage.totalTokens || 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const barTone =
    limit <= 0 ? "bg-surface-3" : pct >= 90 ? "bg-clay-500" : pct >= 75 ? "bg-brass-500" : "bg-brand-700 dark:bg-brand-500";
  const restricted = item.access?.restricted;

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="truncate text-sm font-semibold text-text-main">{item.name || "Untitled key"}</h3>
          </div>

          {/* Status as one quiet sentence, not a row of capsules. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`size-1.5 rounded-full shrink-0 ${
                  status.tone === "ok"
                    ? "bg-brand-600 dark:bg-brand-400"
                    : status.tone === "bad"
                    ? "bg-clay-500"
                    : "bg-text-subtle"
                }`}
                aria-hidden="true"
              />
              {status.label}
            </span>
            <span className="text-text-subtle" aria-hidden="true">·</span>
            <span className={expiry.tone === "bad" ? "text-clay-500" : ""}>{expiry.label}</span>
            <span className="text-text-subtle" aria-hidden="true">·</span>
            <span>{restricted ? `${item.access.allow.length} models allowed` : "all models"}</span>
            <span className="text-text-subtle" aria-hidden="true">·</span>
            <span className={item.injection === false ? "text-text-subtle" : ""}>
              {item.injection === false ? "no injection" : "injection on"}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <code className="rounded-chip bg-surface-2 px-2 py-1 font-mono text-xs text-text-muted">
              {maskKey(item.key)}
            </code>
            <button
              type="button"
              onClick={() => onCopy(item.key)}
              className="rounded-chip p-1.5 text-text-muted transition-colors hover:text-brass-600 dark:hover:text-brass-300 cursor-pointer"
              title="Copy full key"
            >
              <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>
                {copied === item.key ? "check" : "content_copy"}
              </span>
            </button>
            <span className="text-[11px] text-text-muted">created {relativeTime(item.createdAt)}</span>
          </div>

          {restricted && item.access.allow.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.access.allow.slice(0, 8).map((e) => (
                <span
                  key={e}
                  className="rounded-chip bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                >
                  {e}
                </span>
              ))}
              {item.access.allow.length > 8 && (
                <span className="text-[10px] text-text-muted">+{item.access.allow.length - 8} more</span>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Toggle size="sm" checked={item.isActive && !item.expired} onChange={() => onToggle(item)} />
          <button
            type="button"
            onClick={() => onEdit(item)}
            className="rounded-chip bg-surface-2 p-2 text-text-muted transition-colors hover:text-brass-600 dark:hover:text-brass-300 cursor-pointer"
            title="Edit key"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>
              edit
            </span>
          </button>
          <button
            type="button"
            onClick={() => onDelete(item)}
            className="rounded-chip bg-surface-2 p-2 text-text-muted transition-colors hover:text-clay-500 cursor-pointer"
            title="Delete key"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>
              delete
            </span>
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[11px] font-medium text-text-muted">
              {limit > 0
                ? `${item.tokenResetPeriod === "daily" ? "Today" : "Lifetime"} quota`
                : "Token quota"}
            </span>
            <span className="font-mono text-[11px] text-text-muted">
              {limit > 0 ? `${compact(used)} / ${compact(limit)}` : "unlimited"}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              className={`h-full rounded-full transition-all ${barTone}`}
              style={{ width: limit > 0 ? `${pct}%` : "100%", opacity: limit > 0 ? 1 : 0.35 }}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="font-mono text-xs text-text-main">{compact(usage.totalTokens)}</div>
            <div className="text-[10px] text-text-muted">total tok</div>
          </div>
          <div>
            <div className="font-mono text-xs text-text-main">{compact(usage.dailyTokens)}</div>
            <div className="text-[10px] text-text-muted">today tok</div>
          </div>
          <div>
            <div className="font-mono text-xs text-text-main">{fmt(usage.requests)}</div>
            <div className="text-[10px] text-text-muted">requests</div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function AccessKeysClient() {
  const [keys, setKeys] = useState([]);
  // Server-side all-time totals. These include requests made with keys that
  // have since been deleted, so removing a key never rewinds the summary.
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  const [revealed, setRevealed] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKeys(data.keys || []);
      setTotals(data.totals || null);
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const copy = async (key) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setRevealed(key);
    }
  };

  const create = async (payload) => {
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create key");
      setCreateOpen(false);
      setRevealed(data.key);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const update = async (id, payload) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update key");
      setEditing(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (item) => {
    try {
      const res = await fetch(`/api/keys/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      if (!res.ok) throw new Error("Failed to toggle key");
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (item) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/keys/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete key");
      setDeleting(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const stats = useMemo(() => {
    let active = 0;
    for (const k of keys) {
      if (k.isActive && !k.expired) active += 1;
    }
    // Prefer the server totals (they survive key deletion). Fall back to the
    // visible cards only while the first request is still in flight.
    const totalTokens = totals?.totalTokens ?? keys.reduce((n, k) => n + (k.usage?.totalTokens || 0), 0);
    const dailyTokens = totals?.dailyTokens ?? keys.reduce((n, k) => n + (k.usage?.dailyTokens || 0), 0);
    const requests = totals?.requests ?? keys.reduce((n, k) => n + (k.usage?.requests || 0), 0);
    return { totalTokens, dailyTokens, requests, active, total: keys.length };
  }, [keys, totals]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter(
      (k) =>
        (k.name || "").toLowerCase().includes(q) ||
        (k.key || "").toLowerCase().includes(q)
    );
  }, [keys, query]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-main">Access Keys</h1>
          <p className="mt-1 text-sm text-text-muted">
            API keys with token quotas, model restrictions, and expiration.
          </p>
        </div>
        <Button variant="primary" icon="add" onClick={() => setCreateOpen(true)}>
          Create key
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Keys", value: fmt(stats.total), sub: `${stats.active} active` },
          { label: "Total tokens", value: compact(stats.totalTokens), sub: "all time" },
          { label: "Today tokens", value: compact(stats.dailyTokens), sub: "since 00:00 UTC" },
          { label: "Requests", value: fmt(stats.requests), sub: "all time" },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{s.label}</div>
            <div className="mt-1 font-mono text-xl text-text-main">{s.value}</div>
            <div className="text-[11px] text-text-muted">{s.sub}</div>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span
            className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            style={{ fontSize: "18px" }}
          >
            search
          </span>
          <input
            className={`${inputCls} pl-10`}
            placeholder="Search by name or key…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button variant="ghost" icon="refresh" onClick={load} title="Refresh">
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {loading ? (
        <Card className="p-8 text-center text-sm text-text-muted">Loading keys…</Card>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center">
          <span className="material-symbols-outlined text-3xl text-text-muted">vpn_key</span>
          <p className="mt-2 text-sm text-text-muted">
            {keys.length === 0 ? "No API keys yet. Create one to get started." : "No keys match your search."}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((item) => (
            <KeyRow
              key={item.id}
              item={item}
              copied={copied}
              onCopy={copy}
              onToggle={toggle}
              onEdit={setEditing}
              onDelete={setDeleting}
            />
          ))}
        </div>
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Create API key" size="lg">
        <KeyForm
          onSubmit={create}
          onCancel={() => setCreateOpen(false)}
          submitLabel="Create"
          busy={busy}
        />
      </Modal>

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title="Edit API key" size="lg">
        {editing && (
          <KeyForm
            initial={editing}
            onSubmit={(payload) => update(editing.id, payload)}
            onCancel={() => setEditing(null)}
            submitLabel="Save"
            busy={busy}
          />
        )}
      </Modal>

      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} title="Delete API key" size="sm">
        <p className="text-sm text-text-muted">
          Delete <span className="font-medium text-text-main">{deleting?.name}</span>? Requests using this key will
          start failing immediately. This cannot be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => remove(deleting)} loading={busy}>
            Delete
          </Button>
        </div>
      </Modal>

      <Modal isOpen={!!revealed} onClose={() => setRevealed(null)} title="Key created" size="md">
        <p className="text-sm text-text-muted">
          Copy this key now. It stays readable in this list, but treat it as a secret.
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-control bg-surface-2 p-2">
          <code className="flex-1 break-all font-mono text-xs text-text-main">{revealed}</code>
          <button
            type="button"
            onClick={() => copy(revealed)}
            className="rounded-chip p-2 text-text-muted hover:text-brass-600 dark:hover:text-brass-300 cursor-pointer"
            title="Copy"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>
              {copied === revealed ? "check" : "content_copy"}
            </span>
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={() => setRevealed(null)}>
            Done
          </Button>
        </div>
      </Modal>
    </div>
  );
}
