import type { LogRecord, RepoLockList, RunRecord, StepRecord } from "@rescade/core";

export type { LogRecord, RepoLockList, RunRecord, StepRecord };

/** `GET /api/runs/:id`. */
export type RunWithSteps = RunRecord & { steps: StepRecord[] };

/** `GET /api/cascades`. */
export interface CascadeView {
  name: string;
  description: string | null;
  schedule: string[];
  timezone: string | null;
  onBusy: "skip" | "wait";
  waitTimeoutMs: number | null;
  steps: Array<{ type: StepRecord["type"]; label: string }>;
  nextRun: number | null;
  active: RunRecord | null;
  lastRun: RunRecord | null;
}

/** `GET /api/repos`. */
export interface RepoView {
  name: string;
  location: string;
  from?: string;
  state: "unknown" | "ok" | "unreachable" | "wrong-password" | "init-failed" | "error" | "cancelled";
  reason?: string;
  checkedAt?: number;
  id?: string;
  chunkerPolynomial?: string;
  locks?: RepoLockList;
  lockedBy?: { runId: number; cascade: string };
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
