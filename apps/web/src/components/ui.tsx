import type { ReactNode } from "react";
import type { Platform } from "../lib/api";

export function PlatformBadge({ platform }: { platform: Platform | string }) {
  const map: Record<string, { label: string; cls: string }> = {
    facebook: { label: "FB", cls: "bg-blue-600 text-white" },
    instagram: { label: "IG", cls: "bg-gradient-to-tr from-amber-500 via-pink-600 to-purple-600 text-white" },
    messenger: { label: "MS", cls: "bg-sky-500 text-white" },
    whatsapp: { label: "WA", cls: "bg-green-600 text-white" }
  };
  const m = map[platform] ?? { label: String(platform).slice(0, 2).toUpperCase(), cls: "bg-slate-500 text-white" };
  return (
    <span title={String(platform)} className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function ModeBadge({ mode }: { mode?: "sandbox" | "live" | string }) {
  if (!mode) return null;
  return mode === "sandbox"
    ? <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">Sandbox</span>
    : <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">Live</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const good = ["published", "completed", "approved", "confirmed", "active", "connected", "done", "sent"].includes(status);
  const bad = ["failed", "rejected", "cancelled", "blocked", "invalidated"].includes(status);
  const warn = ["pending", "awaiting_approval", "awaiting_permission", "awaiting_connection", "scheduled", "unverified", "partially_completed", "paused", "draft"].includes(status);
  const cls = good
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
    : bad
      ? "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200"
      : warn
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
        : "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${cls}`}>{status.replaceAll("_", " ")}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}>{children}</div>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-base font-bold tracking-tight">{children}</h2>
      {right}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Card className="text-center">
      <p className="font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </Card>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400" role="status">
      <span className="pulse-soft inline-block h-2.5 w-2.5 rounded-full bg-sky-600" />
      {label ?? "Loading..."}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200" role="alert">{message}</div>;
}

export const btnPrimary =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50";
export const btnSecondary =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800";
export const btnDanger =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50";
export const inputCls =
  "w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-200 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:focus:ring-sky-900";
export const labelCls = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";

export function useAsyncError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
