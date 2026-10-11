"use client";

import type { ReactNode } from "react";
import { useState } from "react";

export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-slate-300">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const tones: Record<string, string> = {
    default: "text-white",
    good: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-rose-300",
  };
  return (
    <div className="card-tight">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-black tracking-tight ${tones[tone]}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function Badge({ tone = "slate", children }: { tone?: string; children: ReactNode }) {
  const map: Record<string, string> = {
    slate: "border-slate-400/25 bg-slate-400/10 text-slate-300",
    green: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    red: "border-rose-400/30 bg-rose-400/10 text-rose-300",
    amber: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    cyan: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
    violet: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  };
  return <span className={`chip ${map[tone] ?? map.slate}`}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <span className="label">{label}</span>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-black/30 p-3 text-left transition hover:border-white/20"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? "bg-gradient-to-r from-cyan-400 to-emerald-400" : "bg-slate-700"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition ${checked ? "translate-x-4" : "translate-x-0"}`}
        />
      </span>
      <span>
        <span className="block text-sm font-semibold text-slate-200">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{hint}</span>}
      </span>
    </button>
  );
}

export function Progress({ value, tone = "cyan" }: { value: number; tone?: "cyan" | "rose" }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className={`h-full rounded-full transition-all duration-500 ${
          tone === "rose" ? "bg-rose-400" : "bg-gradient-to-r from-cyan-400 to-emerald-400"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost px-2.5! py-1! text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export function Alert({ tone, children }: { tone: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  const map = {
    info: "border-sky-400/25 bg-sky-400/10 text-sky-100",
    warn: "border-amber-400/25 bg-amber-400/10 text-amber-100",
    error: "border-rose-400/25 bg-rose-400/10 text-rose-100",
    success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-100",
  } as const;
  return <div className={`rounded-xl border p-3.5 text-xs leading-relaxed ${map[tone]}`}>{children}</div>;
}
