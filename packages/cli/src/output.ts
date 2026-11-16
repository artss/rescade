import { formatDuration, type RunState } from "@rescade/core";

/** Exit codes of `rescade run` by the run's final status. */
export const RUN_EXIT: Record<Exclude<RunState, "queued" | "running">, number> = {
  success: 0,
  warning: 3,
  failed: 1,
  cancelled: 130,
  // skipped (repos busy) only happens under the daemon, which shares repo mutexes between runs
  skipped: 75,
  interrupted: 1,
};

export interface StepLine {
  status: string;
  label: string;
  durationMs?: number;
  reason?: string;
}

/** The line printed when a step ends. */
export function stepLine(r: StepLine, tag: string): string {
  if (r.status === "skipped" && r.reason === undefined) return `--- ${tag} skipped: ${r.label}`;
  const took = r.durationMs === undefined ? "" : ` in ${formatDuration(r.durationMs)}`;
  return `<== ${tag} ${r.status}${took}${r.reason === undefined ? "" : `: ${r.reason}`}`;
}

/** A log line of a step, indented under it. */
export function logLine(stream: string, line: string): string {
  return `    ${stream === "info" ? "rescade: " : ""}${line}`;
}

/** Local time as "2026-11-15 18:30:05". */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "512 B", "1.5 KiB", "3.2 GiB". */
export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

/** Rows as columns padded to the widest cell; the last column is not padded. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd())
    .join("\n");
}
