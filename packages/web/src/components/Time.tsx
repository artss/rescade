import { formatTime } from "../format.js";

export function Time({ ms }: { ms: number | undefined | null }) {
  if (ms === undefined || ms === null) return <span className="text-zinc-400">-</span>;
  return <time dateTime={new Date(ms).toISOString()}>{formatTime(ms)}</time>;
}
