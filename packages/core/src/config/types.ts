/** Normalized, validated configuration that the rest of rescade works with. */

export interface Retention {
  last?: number;
  hourly?: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  yearly?: number;
  /** restic duration such as "2y6m" */
  within?: string;
}

export interface Repo {
  path: string;
  password: string;
  /** Repo whose chunker parameters this one is created from (`restic init --from-repo`). */
  from?: string;
  retention?: Retention;
  env: Record<string, string>;
  options: Record<string, string>;
}

export interface BackupSet {
  include: string[];
  exclude: string[];
  tags: string[];
  oneFileSystem: boolean;
  excludeCaches: boolean;
}

interface StepBase {
  /** Optional label shown in status and logs. */
  name?: string;
}

export interface BackupStep extends StepBase {
  type: "backup";
  set: string;
  repo: string;
  tags: string[];
}

export interface RetainStep extends StepBase {
  type: "retain";
  repo: string;
}

export interface PruneStep extends StepBase {
  type: "prune";
  repo: string;
  maxUnused?: string;
}

export interface CheckStep extends StepBase {
  type: "check";
  repo: string;
  readDataSubset?: string;
}

export interface CopyStep extends StepBase {
  type: "copy";
  from: string;
  to: string;
}

interface RunStepBase extends StepBase {
  type: "run";
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  /** Repos whose mutex the step holds while it runs. */
  lock: string[];
}

export interface RunArgvStep extends RunStepBase {
  shell: false;
  command: string[];
}

export interface RunShellStep extends RunStepBase {
  shell: true;
  command: string;
}

export type RunStep = RunArgvStep | RunShellStep;

export type Step = BackupStep | RetainStep | PruneStep | CheckStep | CopyStep | RunStep;

export type OnBusy = "wait" | "skip";

export interface Cascade {
  description?: string;
  /** Cron expressions; empty means the cascade only runs on demand. */
  schedule: string[];
  timezone?: string;
  onBusy: OnBusy;
  waitTimeoutMs?: number;
  steps: Step[];
}

export interface Config {
  repos: Record<string, Repo>;
  sets: Record<string, BackupSet>;
  cascades: Record<string, Cascade>;
}

/** Applied to `run` steps that do not set their own timeout. */
export const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000;
