import type { Config } from "../config/types.js";
import type { EnsureResult } from "../restic/ensure.js";
import type { LogRecord, RunRecord, StepRecord, Store, Trigger } from "../store/store.js";
import {
  describeStep,
  restoreStep,
  runCascade,
  runRestore,
  type RestoreRequest,
  type RunEvent,
  type RunOptions,
  type RunResult,
} from "./cascade.js";
import { RepoLocks, type AcquireOptions, type LockOwner } from "./locks.js";

export interface RunnerOptions extends Pick<RunOptions, "restic" | "env" | "killGraceMs" | "repoCheckTimeoutMs"> {
  store: Store;
  /** Where snapshots are restored (`<restoreDir>/<short id>`); without it `restore` is refused. */
  restoreDir?: string;
}

/** What the runner reports as runs go on; the same changes are written to the store. */
export type RunnerEvent =
  | { kind: "run"; run: RunRecord }
  | { kind: "step"; step: StepRecord }
  | { kind: "log"; runId: number; log: LogRecord }
  | { kind: "repo"; repo: string; result: EnsureResult; at: number };

/** Run statuses a rerun can start from. */
const RERUNNABLE = new Set<RunRecord["status"]>(["failed", "cancelled", "interrupted", "skipped"]);

/**
 * The step a rerun of the run starts from: the first one that did not end `success` or `warning`
 * (a step without a record did not run). A string says why the run cannot be rerun.
 * The steps before it must still be the same in the cascade (by their labels): the config may have changed.
 */
export function rerunFrom(run: RunRecord & { steps: StepRecord[] }, config: Config): number | string {
  if (run.cascade === undefined) return "a restore cannot be rerun";
  if (!RERUNNABLE.has(run.status)) return `run ${run.id} is ${run.status}, only a failed, cancelled, interrupted or skipped run can be rerun`;
  if (run.steps.length === 0) return `run ${run.id} ran no steps`;
  const cascade = config.cascades[run.cascade];
  if (!cascade) return `cascade "${run.cascade}" is no longer in the config`;
  const byIndex = new Map(run.steps.map((s) => [s.index, s]));
  let from = 0;
  while (from < cascade.steps.length && ["success", "warning"].includes(byIndex.get(from)?.status ?? "")) from++;
  if (from === cascade.steps.length) return `all steps of run ${run.id} are done`;
  for (let i = 0; i < from; i++) {
    const label = describeStep(cascade.steps[i]!);
    if (byIndex.get(i)!.label !== label) {
      return `the steps of cascade "${run.cascade}" changed since run ${run.id}: step ${i + 1} was "${byIndex.get(i)!.label}", now "${label}"`;
    }
  }
  return from;
}

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
  /** By run id. */
  private readonly active = new Map<number, Active>();
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

  /** Where snapshots are restored; undefined = restore is off. */
  get restoreDir(): string | undefined {
    return this.options.restoreDir;
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
    return this.startCascade(cascadeName, trigger);
  }

  /**
   * Starts a cascade again from the failed step of one of its runs (see `rerunFrom`); the old run stays as it was.
   * Throws if the run cannot be rerun.
   */
  rerun(runId: number): RunRecord {
    const source = this.options.store.run(runId);
    if (!source) throw new Error(`no run ${runId}`);
    const from = rerunFrom(source, this.config);
    if (typeof from === "string") throw new Error(from);
    return this.startCascade(source.cascade!, "manual", { rerunOf: runId, fromStep: from });
  }

  private startCascade(cascadeName: string, trigger: Trigger, rerun?: { rerunOf: number; fromStep: number }): RunRecord {
    const config = this.config;
    const cascade = config.cascades[cascadeName];
    if (!cascade) throw new Error(`unknown cascade "${cascadeName}"`);
    if (this.stopping) throw new Error("the runner is stopping");
    const { store } = this.options;
    const now = Date.now();

    const previous = [...this.active.values()].find((a) => a.run.cascade === cascadeName);
    if (previous) {
      const run = store.insertRun({
        cascade: cascadeName,
        trigger,
        ...rerun,
        status: "skipped",
        reason: `run ${previous.run.id} of this cascade is still in progress`,
        startedAt: now,
        finishedAt: now,
      });
      this.emit({ kind: "run", run: { ...run } });
      return run;
    }

    const run = store.insertRun({ cascade: cascadeName, trigger, ...rerun, status: "running", startedAt: now });
    return this.start(
      run,
      (index) => {
        const s = cascade.steps[index]!;
        return { type: s.type, ...(s.type === "backup" ? { repo: s.repo } : {}) };
      },
      (options) =>
        runCascade(
          config,
          cascadeName,
          {
            ...options,
            lock: (repos, wait) => options.acquire(repos, { wait: cascade.onBusy === "wait", timeoutMs: cascade.waitTimeoutMs, ...wait }),
          },
          rerun?.fromStep,
        ),
    );
  }

  /**
   * Starts restoring a snapshot (or some of its paths) into `<restoreDir>/<short id>` and returns the run's record.
   * The run waits for the repo's mutex as long as it takes, so prune and backup wait for the restore.
   */
  restore(request: RestoreRequest): RunRecord {
    const config = this.config;
    if (this.stopping) throw new Error("the runner is stopping");
    if (this.options.restoreDir === undefined) throw new Error("restore is not enabled: no restore directory is set");
    if (!config.repos[request.repo]) throw new Error(`unknown repo "${request.repo}"`);
    const step = restoreStep(request, this.options.restoreDir);
    const run = this.options.store.insertRun({
      restore: { repo: step.repo, snapshot: step.snapshot, paths: step.paths, target: step.target },
      trigger: "manual",
      status: "running",
      startedAt: Date.now(),
    });
    return this.start(
      run,
      () => ({ type: "restore", repo: step.repo }),
      (options) => runRestore(config, step, { ...options, lock: (repos, wait) => options.acquire(repos, { wait: true, ...wait }) }),
    );
  }

  /** Follows a run that was just inserted as `running`: keeps its record and steps up to date and reports them. */
  private start(
    run: RunRecord,
    stepInfo: (index: number) => Pick<StepRecord, "type" | "repo">,
    exec: (
      options: RunOptions & { acquire: (repos: string[], options: AcquireOptions) => ReturnType<RepoLocks["acquire"]> },
    ) => Promise<RunResult>,
  ): RunRecord {
    const { store } = this.options;
    // before exec: a step without repos starts synchronously
    this.emit({ kind: "run", run: { ...run } });
    const controller = new AbortController();
    const owner: LockOwner = { runId: run.id, ...(run.cascade === undefined ? {} : { cascade: run.cascade }) };
    const setStatus = (status: RunRecord["status"], reason?: string, finishedAt?: number) => {
      run.status = status;
      if (reason === undefined) delete run.reason;
      else run.reason = reason;
      if (finishedAt !== undefined) run.finishedAt = finishedAt;
      store.updateRun(run.id, status, reason, finishedAt);
      this.emit({ kind: "run", run: { ...run } });
    };

    const step = (index: number, label: string) => ({ runId: run.id, index, label, ...stepInfo(index) });
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
          this.saveStep({ ...step(e.result.index, e.result.label), ...e.result, status });
          return;
        }
      }
    };

    const finish = (result: RunResult) =>
      this.stopping && result.status === "cancelled"
        ? setStatus("interrupted", "the daemon stopped during the run", result.finishedAt)
        : setStatus(result.status, result.reason, result.finishedAt);
    const done = exec({
      restic: this.options.restic,
      env: this.options.env,
      killGraceMs: this.options.killGraceMs,
      repoCheckTimeoutMs: this.options.repoCheckTimeoutMs,
      signal: controller.signal,
      onEvent,
      onRepoChecked: (repo, result) => this.emit({ kind: "repo", repo, result, at: Date.now() }),
      acquire: (repos, options) => this.locks.acquire(repos, owner, options),
    })
      .then(finish, (e: unknown) => setStatus("failed", e instanceof Error ? e.message : String(e), Date.now()))
      .finally(() => this.active.delete(run.id));

    this.active.set(run.id, { run, controller, done });
    return { ...run };
  }

  /** Cancels a run in progress (also one waiting for repos). False if it is not in progress. */
  cancel(runId: number): boolean {
    const a = this.active.get(runId);
    a?.controller.abort();
    return a !== undefined;
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
