import type { LogRecord } from "./types.js";

/** A run's log as the page has it: lines from the API and from events, in id order. */
export interface LogData {
  lines: LogRecord[];
  /** The whole log was fetched once; until then only lines from events are here. */
  complete: boolean;
}

/** Joins lines by id, without repeats; a line from events may also come in a fetch. */
export function mergeLog(have: LogRecord[], more: LogRecord[]): LogRecord[] {
  if (more.length === 0) return have;
  const last = have.at(-1)?.id ?? -1;
  if (more.every((l, i) => l.id > (i === 0 ? last : more[i - 1]!.id))) return [...have, ...more];
  const byId = new Map<number, LogRecord>();
  for (const l of have) byId.set(l.id, l);
  for (const l of more) byId.set(l.id, l);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
