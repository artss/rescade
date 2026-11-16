import { formatDuration } from "./format.js";
import type { CascadeStep, Retention } from "./types.js";

/** One line under a step: what it is and its value. */
export type StepDetail = [term: string, value: string];

const KEEP: Array<keyof Retention> = ["last", "hourly", "daily", "weekly", "monthly", "yearly"];

/** "7 daily, 4 weekly, within 1y". */
export function formatRetention(r: Retention): string {
  const parts = KEEP.flatMap((k) => (r[k] === undefined ? [] : [`${r[k]} ${k}`]));
  if (r.within !== undefined) parts.push(`within ${r.within}`);
  return parts.join(", ");
}

/**
 * The settings of a step worth showing under its label. A named step hides its summary in the label,
 * so its repos are listed here too.
 */
export function stepDetails(s: CascadeStep): StepDetail[] {
  const named = s.name !== null;
  const out: StepDetail[] = [];
  const add = (term: string, value: string | null | undefined, when = true) => {
    if (when && value) out.push([term, value]);
  };
  switch (s.type) {
    case "backup": {
      add("To", `${s.set} -> ${s.repo}`, named);
      add("Paths", s.include.join(", "));
      add("Exclude", s.exclude.join(", "));
      add("Tags", s.tags.join(", "));
      const flags = [s.oneFileSystem && "one file system", s.excludeCaches && "exclude caches"].filter(Boolean);
      add("Options", flags.join(", "));
      break;
    }
    case "retain":
      add("Repo", s.repo, named);
      add("Keep", s.retention && formatRetention(s.retention));
      break;
    case "prune":
      add("Repo", s.repo, named);
      add("Max unused", s.maxUnused);
      break;
    case "check":
      add("Repo", s.repo, named);
      add("Read data", s.readDataSubset);
      break;
    case "copy":
      add("Copy", `${s.from} -> ${s.to}`, named);
      break;
    case "run":
      add("Command", s.shell ? s.command : s.argv?.join(" "), named);
      add("Directory", s.cwd);
      add("Env", s.env.join(", "));
      add("Locks", s.lock.join(", "));
      add("Timeout", formatDuration(s.timeoutMs));
      break;
  }
  return out;
}
