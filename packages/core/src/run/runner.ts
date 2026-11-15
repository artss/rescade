import type { Config } from "../config/types.js";
import type { EnsureResult } from "../restic/ensure.js";
import type { LogRecord, RunRecord, StepRecord, Store, Trigger } from "../store/store.js";
import { runCascade, type RunEvent, type RunOptions, type RunResult } from "./cascade.js";
import { RepoLocks } from "./locks.js";

export interface RunnerOptions extends Pick<RunOptions, "restic" | "env" | "killGraceMs" | "repoCheckTimeoutMs"> {
  store: Store;
}

/** What the runner reports as runs go on; the same changes are written to the store. */
export type RunnerEvent =
  | { kind: "run"; run: RunRecord }
  | { kind: "step"; step: StepRecord }
  | { kind: "log"; runId: number; log: LogRecord }
  | { kind: "repo"; repo: string; result: EnsureResult; at: number };

interface Active {
  run: RunRecord;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Starts cascades, keeps their state in the store and reports events.
 * A cascade never runs twice at once; repos are shared through mutexes taken per step.
 */
export class Runner {
  readonly locks = new RepoLocks();
  private config: Config;
  private readonly active = new Map<string, Active>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private stopping = false;

  constructor(
    config: Config,
    private readonly options: RunnerOptions,
  ) {
    this.config = config;
  }

  /** New runs use the new config; runs in progress finish with the one they started with. */
  setConfig(config: Config): void {
    this.config = config;
  }

  subscribe(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True once `stop` was called: new runs are refused. */
  get isStopping(): boolean {
    return this.stopping;
  }

  /** Runs in progress, including those waiting for repos. */
  running(): RunRecord[] {
    return [...this.active.values()].map((a) => ({ ...a.run }));
  }

  /**
   * Starts a run of the cascade and returns its record right away.
   * If the previous run of the cascade is still in progress, the new one is recorded as skipped.
   */
  trigger(cascadeName: string, trigger: Trigger): RunRecord {
    const config = this.config;
    const cascade = config.cascades[cascadeName];
    if (!cascade) throw new Error(`unknown cascade "${cascadeName}"`);
    if (this.stopping) throw new Error("the runner is stopping");
    const { store } = this.options;
    const now = Date.now();

    const previous = this.active.get(cascadeName);
    if (previous) {
      const run = store.insertRun({
        cascade: cascadeName,
        trigger,
        status: "skipped",
        reason: `run ${previous.run.id} of this cascade is still in progress`,
        startedAt: now,
        finishedAt: now,
      });
      this.emit({ kind: "run", run: { ...run } });
      return run;
    }

    const run = store.insertRun({ cascade: cascadeName, trigger, status: "running", startedAt: now });
    // before runCascade: a step without repos starts synchronously
    this.emit({ kind: "run", run: { ...run } });
    const controller = new AbortController();
    const owner = { runId: run.id, cascade: cascadeName };
    const setStatus = (status: RunRecord["status"], reason?: string, finishedAt?: number) => {
      run.status = status;
      if (reason === undefined) delete run.reason;
      else run.reason = reason;
      if (finishedAt !== undefined) run.finishedAt = finishedAt;
      store.updateRun(run.id, status, reason, finishedAt);
      this.emit({ kind: "run", run: { ...run } });
    };

    const step = (index: number, label: string) => ({ runId: run.id, index, type: cascade.steps[index]!.type, label });
    const onEvent = (e: RunEvent) => {
      switch (e.kind) {
        case "step-wait":
          this.saveStep({ ...step(e.index, e.label), status: "queued", reason: e.reason });
          setStatus("queued", e.reason);
          return;
        case "step-start":
          this.saveStep({ ...step(e.index, e.label), status: "running", startedAt: Date.now() });
          if (run.status !== "running") setStatus("running");
          return;
        case "log": {
          const log = store.appendLog(run.id, { step: e.index, ts: Date.now(), stream: e.stream, line: e.line });
          this.emit({ kind: "log", runId: run.id, log });
          return;
        }
        case "step-end": {
          const status = this.stopping && e.result.status === "cancelled" ? "interrupted" : e.result.status;
          this.saveStep({ runId: run.id, ...e.result, status });
          return;
        }
      }
    };

    const finish = (result: RunResult) =>
      this.stopping && result.status === "cancelled"
        ? setStatus("interrupted", "the daemon stopped during the run", result.finishedAt)
        : setStatus(result.status, result.reason, result.finishedAt);
    const done = runCascade(config, cascadeName, {
      restic: this.options.restic,
      env: this.options.env,
      killGraceMs: this.options.killGraceMs,
      repoCheckTimeoutMs: this.options.repoCheckTimeoutMs,
      signal: controller.signal,
      onEvent,
      onRepoChecked: (repo, result) => this.emit({ kind: "repo", repo, result, at: Date.now() }),
      lock: (repos, wait) =>
        this.locks.acquire(repos, owner, {
          wait: cascade.onBusy === "wait",
          timeoutMs: cascade.waitTimeoutMs,
          signal: wait.signal,
          onWait: wait.onWait,
        }),
    })
      .then(finish, (e: unknown) => setStatus("failed", e instanceof Error ? e.message : String(e), Date.now()))
      .finally(() => this.active.delete(cascadeName));

    this.active.set(cascadeName, { run, controller, done });
    return { ...run };
  }

  /** Cancels a run in progress (also one waiting for repos). False if it is not in progress. */
  cancel(runId: number): boolean {
    for (const a of this.active.values()) {
      if (a.run.id === runId) {
        a.controller.abort();
        return true;
      }
    }
    return false;
  }

  /**
   * Refuses new runs, stops the ones in progress (SIGTERM to their processes) and waits for them.
   * They end as `interrupted`, not `cancelled`.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const a of this.active.values()) a.controller.abort();
    await this.idle();
  }

  /** Resolves when no run is in progress. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  private saveStep(step: StepRecord): void {
    this.options.store.saveStep(step);
    this.emit({ kind: "step", step });
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
