import type { ReactNode } from "react";
import { Link } from "wouter";
import { ApiError } from "../api.js";
import { formatTime } from "../format.js";

const tones = {
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  gray: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

const toneOf: Record<string, keyof typeof tones> = {
  success: "green",
  ok: "green",
  warning: "amber",
  unreachable: "amber",
  running: "blue",
  queued: "violet",
  cancelled: "gray",
  skipped: "gray",
  unknown: "gray",
};

/** A run, step or repo state; states not listed above are problems. */
export function Badge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${tones[toneOf[status] ?? "red"]}`}>
      {status}
    </span>
  );
}

export function Time({ ms }: { ms: number | undefined | null }) {
  if (ms === undefined || ms === null) return <span className="text-zinc-400">-</span>;
  return <time dateTime={new Date(ms).toISOString()}>{formatTime(ms)}</time>;
}

export function RunLink({ id, children }: { id: number; children?: ReactNode }) {
  return (
    <Link href={`/runs/${id}`} className="text-sky-700 hover:underline dark:text-sky-400">
      {children ?? `run ${id}`}
    </Link>
  );
}

export function Loading() {
  return <p className="text-sm text-zinc-500">Loading…</p>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const text = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {text}
    </p>
  );
}

export function Button({
  children,
  danger = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  const color = danger
    ? "bg-red-600 hover:bg-red-700 text-white"
    : "bg-zinc-900 hover:bg-zinc-700 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
  return (
    <button
      type="button"
      {...props}
      className={`rounded px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${color}`}
    >
      {children}
    </button>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">{children}</section>
  );
}

export const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500";
export const td = "px-3 py-2 align-top";
