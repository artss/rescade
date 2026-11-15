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
