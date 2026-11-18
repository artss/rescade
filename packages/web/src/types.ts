import type { LogRecord, RepoLockList, Retention, RunRecord, Snapshot, SnapshotDir, SnapshotEntry, StepRecord } from "@rescade/core";

export type { LogRecord, RepoLockList, Retention, RunRecord, Snapshot, SnapshotDir, SnapshotEntry, StepRecord };

/** `GET /api/runs/:id`. */
export type RunWithSteps = RunRecord & { steps: StepRecord[] };

/** A step of `GET /api/cascades`: its type, label and the settings of that type. */
export type CascadeStep = { label: string; name: string | null } & (
  | {
      type: "backup";
      set: string;
      repo: string;
      include: string[];
      exclude: string[];
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
      command?: string;
      argv?: string[];
      cwd: string | null;
      /** Names only, without values. */
      env: string[];
      timeoutMs: number;
      lock: string[];
    }
);

/** `GET /api/cascades`. */
export interface CascadeView {
  name: string;
  group: string | null;
  description: string | null;
  schedule: string[];
  timezone: string | null;
  onBusy: "skip" | "wait";
  waitTimeoutMs: number | null;
  steps: CascadeStep[];
  nextRun: number | null;
  active: RunRecord | null;
  lastRun: RunRecord | null;
}

/** `GET /api/repos`. */
export interface RepoView {
  name: string;
  location: string;
  group?: string;
  from?: string;
  state: "unknown" | "ok" | "unreachable" | "wrong-password" | "init-failed" | "error" | "cancelled";
  reason?: string;
  checkedAt?: number;
  id?: string;
  chunkerPolynomial?: string;
  locks?: RepoLockList;
  lockedBy?: { runId: number; cascade?: string };
}

/** `GET /api/status`. */
export interface DaemonStatus {
  version: string;
  startedAt: number;
  config: {
    path: string;
    loadedAt: number;
    lastReload?: { at: number; ok: boolean; errors: string[] };
  };
}

/** Data of `GET /api/events`. */
export type ServerEvent =
  | { kind: "run"; run: RunRecord }
  | { kind: "step"; step: StepRecord }
  | { kind: "log"; runId: number; log: LogRecord }
  | { kind: "repo"; repo: string; at: number };
