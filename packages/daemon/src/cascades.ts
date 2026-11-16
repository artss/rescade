import { describeStep, type Config, type Retention, type Step } from "@rescade/core";

/** What `GET /cascades` shows about one step: its type, label and the settings of that type. */
export type StepView = { type: Step["type"]; label: string; name: string | null } & (
  | {
      type: "backup";
      set: string;
      repo: string;
      include: string[];
      exclude: string[];
      /** The set's tags and the step's, as passed to restic. */
      tags: string[];
      oneFileSystem: boolean;
      excludeCaches: boolean;
    }
  | { type: "retain"; repo: string; retention: Retention | null }
  | { type: "prune"; repo: string; maxUnused: string | null }
  | { type: "check"; repo: string; readDataSubset: string | null }
  | { type: "copy"; from: string; to: string }
  | {
      type: "run";
      shell: boolean;
      /** The script for `shell: true`. */
      command?: string;
      /** The program and its arguments for `shell: false`. */
      argv?: string[];
      cwd: string | null;
      /** Names only: the values may hold secrets. */
      env: string[];
      timeoutMs: number;
      lock: string[];
    }
);

export function stepView(step: Step, config: Config): StepView {
  const base = { label: describeStep(step), name: step.name ?? null };
  switch (step.type) {
    case "backup": {
      const set = config.sets[step.set];
      return {
        type: "backup",
        ...base,
        set: step.set,
        repo: step.repo,
        include: set?.include ?? [],
        exclude: set?.exclude ?? [],
        tags: [...new Set([...(set?.tags ?? []), ...step.tags])],
        oneFileSystem: set?.oneFileSystem ?? false,
        excludeCaches: set?.excludeCaches ?? false,
      };
    }
    case "retain":
      return { type: "retain", ...base, repo: step.repo, retention: config.repos[step.repo]?.retention ?? null };
    case "prune":
      return { type: "prune", ...base, repo: step.repo, maxUnused: step.maxUnused ?? null };
    case "check":
      return { type: "check", ...base, repo: step.repo, readDataSubset: step.readDataSubset ?? null };
    case "copy":
      return { type: "copy", ...base, from: step.from, to: step.to };
    case "run":
      return {
        type: "run",
        ...base,
        shell: step.shell,
        ...(step.shell ? { command: step.command } : { argv: step.command }),
        cwd: step.cwd ?? null,
        env: Object.keys(step.env),
        timeoutMs: step.timeoutMs,
        lock: step.lock,
      };
  }
}
