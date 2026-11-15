const p = (n: number) => String(n).padStart(2, "0");

/** Local time as "2026-11-15 03:00:00". */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "850ms", "12s", "3m 05s", "2h 07m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${p(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${p(Math.floor(s / 60) % 60)}m`;
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
