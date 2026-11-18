"use client";

import { Input } from "@/shared/components";

/** Reusable endpoint row component */
export default function EndpointRow({ label, url, copyId, copied, onCopy, badge, actions }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[64px] sm:min-w-[88px] text-center ${
          (badge === "CF" || badge === "TS") ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
        }`}>{label}</span>
      <Input value={url} readOnly className="flex-1 min-w-0 font-mono text-sm" />
      <button
        onClick={() => onCopy(url, copyId)}
        aria-label={`Copy ${label} URL`}
        className="flex items-center justify-center min-w-[40px] min-h-[40px] hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all active:scale-95 shrink-0 cursor-pointer"
      >
        <span className="material-symbols-outlined text-[18px]">{copied === copyId ? "check" : "content_copy"}</span>
      </button>
      {actions}
    </div>
  );
}
