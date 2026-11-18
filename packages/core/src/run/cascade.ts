import path from "node:path";
import { formatDuration } from "../config/schema.js";
import type { Config, RunStep, Step } from "../config/types.js";
import { describeExit, ensureRepo, type EnsureMemo, type EnsureResult } from "../restic/ensure.js";
import { runProcess, type ProcessResult } from "../restic/process.js";
import {
  backupArgs,
  checkArgs,
  copyArgs,
  execRestic,
  EXIT,
  failureReason,
  forgetArgs,
  pruneArgs,
  restoreArgs,
  type ResticContext,
} from "../restic/restic.js";
import type { LockResult } from "./locks.js";

export type StepStatus = "success" | "warning" | "failed" | "cancelled" | "skipped";
/** `skipped`: a step found its repos busy (`on-busy: skip`, or `wait` ran out of time). */
export type RunStatus = "success" | "warning" | "failed" | "cancelled" | "skipped";

/** A restore is run like a cascade of this one step; it is not written in the config. */
export interface RestoreStep {
  type: "restore";
  repo: string;
  /** The snapshot id as given: hex, at least 8 characters. */
  snapshot: string;
  /** Absolute paths to restore; empty = the whole snapshot. */
  paths: string[];
  /** The directory restic restores into. */
  target: string;
}

export type StepType = Step["type"] | "restore";

/** What to restore; the target directory comes from the daemon's settings. */
export interface RestoreRequest {
  repo: string;
  snapshot: string;
  /** Absolute paths; empty or absent = the whole snapshot. */
  paths?: string[];
}

export interface StepResult {
  index: number;
  type: StepType;
  label: string;
  status: StepStatus;
  /** Exit code of the step's main process, when it ran to the end. */
  exitCode?: number;
  /** Epoch milliseconds; absent for skipped steps. */
  startedAt?: number;
  durationMs?: number;
  reason?: string;
  /** Last stderr lines of the failed process. */
  stderrTail?: string[];
  /** backup: restic's JSON summary. */
  summary?: Record<string, unknown>;
}

export interface RunResult {
  /** Absent for a restore. */
  cascade?: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number;
  steps: StepResult[];
  /** Why the run did not succeed: the reason of the step that stopped it. */
  reason?: string;
}

/** "info" lines come from rescade itself, the others from the step's process. */
export type LogStream = "stdout" | "stderr" | "info";

export type RunEvent =
  | { kind: "step-wait"; index: number; label: string; reason: string }
  | { kind: "step-start"; index: number; label: string }
  | { kind: "log"; index: number; stream: LogStream; line: string }
  | { kind: "step-end"; result: StepResult };

export interface RunOptions {
  /** Path to the restic binary. */
  restic: string;
  /** Environment restic starts from. `run` steps do not get it, only their own `env`. */
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Time between SIGTERM and SIGKILL when a step is cancelled or times out. */
  killGraceMs?: number;
  /** Limit for checking that a repo exists and is reachable (`restic cat config`). */
  repoCheckTimeoutMs?: number;
  onEvent?: (event: RunEvent) => void;
  /** Called with the outcome of every repo check made before a step. */
  onRepoChecked?: ResticContext["onRepoChecked"];
  /**
   * Takes the mutexes of the repos a step touches and applies `on-busy`.
   * Without it steps run unguarded (`run --local`).
   */
  lock?: (repos: string[], wait: { signal?: AbortSignal; onWait: (reason: string) => void }) => Promise<LockResult>;
}

/** Repos whose mutex a step holds while it runs. */
export function stepRepos(step: Step | RestoreStep): string[] {
  switch (step.type) {
    case "copy":
      return [step.from, step.to];
    case "run":
      return step.lock;
    default:
      return [step.repo];
  }
}

/** A short human description of a step, e.g. "copy system-local -> system-i1". */
export function describeStep(step: Step | RestoreStep): string {
  if (step.type === "restore") {
    const what = step.paths.length === 0 ? "" : ` (${step.paths.length === 1 ? step.paths[0] : `${step.paths.length} paths`})`;
    return `restore ${step.snapshot.slice(0, 8)}${what} from ${step.repo} -> ${step.target}`;
  }
  if (step.name !== undefined) return step.name;
  switch (step.type) {
    case "backup":
      return `backup ${step.set} -> ${step.repo}`;
    case "retain":
    case "prune":
    case "check":
      return `${step.type} ${step.repo}`;
    case "copy":
      return `copy ${step.from} -> ${step.to}`;
    case "run":
      return `run ${step.shell ? step.command : step.command.join(" ")}`;
  }
}

/** Runs the steps of one cascade in order. Stops at the first failed step; the rest are skipped. */
export async function runCascade(config: Config, cascadeName: string, options: RunOptions): Promise<RunResult> {
  const cascade = config.cascades[cascadeName];
  if (!cascade) throw new Error(`unknown cascade "${cascadeName}"`);
  return { cascade: cascadeName, ...(await runSteps(config, cascade.steps, options)) };
}

/** Paths one restore may name; each becomes an argument of restic. */
export const MAX_RESTORE_PATHS = 1000;

/** Where a snapshot is restored: `<restoreDir>/<short id>`, with the snapshot's full paths below it. */
export const restoreTarget = (restoreDir: string, snapshot: string): string => path.join(restoreDir, snapshot.slice(0, 8));

/** The step a restore request becomes. Paths are normalized; "/" among them means the whole snapshot. */
export function restoreStep(request: RestoreRequest, restoreDir: string): RestoreStep {
  const paths = [...new Set((request.paths ?? []).map((p) => path.posix.normalize(p).replace(/(.)\/$/, "$1")))];
  return {
    type: "restore",
    repo: request.repo,
    snapshot: request.snapshot,
    paths: paths.includes("/") ? [] : paths,
    target: restoreTarget(restoreDir, request.snapshot),
  };
}

/** Restores a snapshot (or some of its paths): a run of one step that takes the repo's mutex. */
export function runRestore(config: Config, step: RestoreStep, options: RunOptions): Promise<RunResult> {
  if (!config.repos[step.repo]) throw new Error(`unknown repo "${step.repo}"`);
  return runSteps(config, [step], options);
}

async function runSteps(config: Config, steps: Array<Step | RestoreStep>, options: RunOptions): Promise<RunResult> {
  const emit = options.onEvent ?? (() => {});
  const ctx: ResticContext = {
    binary: options.restic,
    env: options.env,
    repos: config.repos,
    signal: options.signal,
    killGraceMs: options.killGraceMs,
    repoCheckTimeoutMs: options.repoCheckTimeoutMs,
    onRepoChecked: options.onRepoChecked,
  };
  const startedAt = Date.now();
  const results: StepResult[] = [];
  let stopped = false;
  let reason: string | undefined;

  for (const [index, step] of steps.entries()) {
    const label = describeStep(step);
    if (stopped || options.signal?.aborted) {
      const result: StepResult = { index, type: step.type, label, status: "skipped" };
      results.push(result);
      emit({ kind: "step-end", result });
      continue;
    }

    let release = () => {};
    const repos = stepRepos(step);
    if (options.lock && repos.length > 0) {
      const lock = await options.lock(repos, {
        signal: options.signal,
        onWait: (why) => emit({ kind: "step-wait", index, label, reason: why }),
      });
      if (!lock.ok) {
        const result: StepResult = { index, type: step.type, label, status: lock.status, reason: lock.reason };
        results.push(result);
        emit({ kind: "step-end", result });
        stopped = true;
        reason = `${label}: ${lock.reason}`;
        continue;
      }
      release = lock.release;
    }

    emit({ kind: "step-start", index, label });
    const log = (stream: LogStream, line: string) => emit({ kind: "log", index, stream, line });
    const stepStart = Date.now();
    let outcome: Outcome;
    try {
      outcome = await runStep(step, config, ctx, options, log);
    } catch (e) {
      outcome = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
    } finally {
      release();
    }
    const result: StepResult = {
      index,
      type: step.type,
      label,
      ...outcome,
      startedAt: stepStart,
      durationMs: Date.now() - stepStart,
    };
    results.push(result);
    emit({ kind: "step-end", result });
    if (outcome.status === "failed" || outcome.status === "cancelled") {
      stopped = true;
      reason = `${label}: ${outcome.reason ?? outcome.status}`;
    }
  }

  return {
    status: overall(results),
    startedAt,
    finishedAt: Date.now(),
    steps: results,
    ...(reason === undefined ? {} : { reason }),
  };
}

function overall(steps: StepResult[]): RunStatus {
  const has = (s: StepStatus) => steps.some((r) => r.status === s);
  if (has("cancelled")) return "cancelled";
  if (has("failed")) return "failed";
  // steps skipped after a failure have no reason; one with a reason found its repos busy
  if (steps.some((r) => r.status === "skipped" && r.reason !== undefined)) return "skipped";
  if (has("warning")) return "warning";
  return "success";
}

type Outcome = Pick<StepResult, "status" | "exitCode" | "reason" | "stderrTail" | "summary">;

async function runStep(
  step: Step | RestoreStep,
  config: Config,
  ctx: ResticContext,
  options: RunOptions,
  log: (stream: LogStream, line: string) => void,
): Promise<Outcome> {
  const memo: EnsureMemo = new Map();
  const info = (line: string) => log("info", line);
  const ensure = (repo: string, init = true) => ensureRepo(ctx, repo, info, memo, { init });
  const passLines = { onLine: log };

  switch (step.type) {
    case "backup": {
      const ready = await ensure(step.repo);
      if (!ready.ok) return notReady(ready);
      const set = config.sets[step.set];
      if (!set) return { status: "failed", reason: `unknown set "${step.set}"` };
      const output = jsonOutput(log, backupSummary);
      const r = await execRestic(ctx, step.repo, backupArgs(set, step), { onLine: output.onLine });
      const summary = output.summary();
      if (r.code === EXIT.partial && !r.cancelled) {
        return {
          status: "warning",
          exitCode: r.code,
          reason: "some source files could not be read (restic exit code 3)",
          summary,
        };
      }
      // with --json, errors on stderr are JSON too (the last one is an exit_error)
      return { ...fromProcess({ ...r, stderrTail: r.stderrTail.map((l) => readableJsonLine(l)) }, "restic backup"), summary };
    }
    case "restore": {
      // restoring from a repo that is not there must not create it
      const ready = await ensure(step.repo, false);
      if (!ready.ok) return notReady(ready);
      const output = jsonOutput(log, restoreSummary);
      const r = await execRestic(ctx, step.repo, restoreArgs(step.snapshot, step.target, step.paths), {
        onLine: output.onLine,
      });
      const summary = output.summary();
      const outcome = {
        ...fromProcess({ ...r, stderrTail: r.stderrTail.map((l) => readableJsonLine(l)) }, "restic restore"),
        ...(summary === undefined ? {} : { summary }),
      };
      // restic restores nothing, without an error, when the snapshot has none of the paths
      const touched = Number(summary?.files_restored ?? 0) + Number(summary?.files_skipped ?? 0);
      if (outcome.status === "success" && step.paths.length > 0 && touched === 0) {
        return { ...outcome, status: "failed", reason: `snapshot ${step.snapshot.slice(0, 8)} has none of the given paths` };
      }
      return outcome;
    }
    case "retain": {
      const retention = config.repos[step.repo]?.retention;
      if (!retention) return { status: "failed", reason: `repo "${step.repo}" has no retention policy` };
      const ready = await ensure(step.repo);
      if (!ready.ok) return notReady(ready);
      return fromProcess(await execRestic(ctx, step.repo, forgetArgs(retention), passLines), "restic forget");
    }
    case "prune": {
      const ready = await ensure(step.repo);
      if (!ready.ok) return notReady(ready);
      return fromProcess(await execRestic(ctx, step.repo, pruneArgs(step), passLines), "restic prune");
    }
    case "check": {
      const ready = await ensure(step.repo);
      if (!ready.ok) return notReady(ready);
      return fromProcess(await execRestic(ctx, step.repo, checkArgs(step), passLines), "restic check");
    }
    case "copy": {
      // the source first: it may be what the target gets initialized from
      const source = await ensure(step.from);
      if (!source.ok) return notReady(source);
      const target = await ensure(step.to);
      if (!target.ok) return notReady(target);

      let mismatch: string | undefined;
      if (source.config.chunkerPolynomial !== target.config.chunkerPolynomial) {
        mismatch =
          `chunker parameters differ: "${step.from}" has ${source.config.chunkerPolynomial}, ` +
          `"${step.to}" has ${target.config.chunkerPolynomial}; copied data will not deduplicate`;
        info(`warning: ${mismatch}`);
      }
      const outcome = fromProcess(
        await execRestic(ctx, step.to, copyArgs(), { from: step.from, onLine: log }),
        "restic copy",
      );
      return outcome.status === "success" && mismatch !== undefined
        ? { ...outcome, status: "warning", reason: mismatch }
        : outcome;
    }
    case "run":
      return fromProcess(await runCommand(step, options, log), "command", step.timeoutMs);
  }
}

function notReady(r: Extract<EnsureResult, { ok: false }>): Outcome {
  return r.problem === "cancelled" ? { status: "cancelled", reason: "cancelled" } : { status: "failed", reason: r.reason };
}

function fromProcess(r: ProcessResult, what: string, timeoutMs?: number): Outcome {
  if (r.cancelled) return { status: "cancelled", reason: "cancelled" };
  if (r.spawnError !== undefined) return { status: "failed", reason: `${what} could not be started: ${r.spawnError}` };
  if (r.timedOut) {
    const last = r.stderrBeforeStop === undefined ? "" : `: ${r.stderrBeforeStop}`;
    return {
      status: "failed",
      reason: `${what} timed out after ${formatDuration(timeoutMs ?? 0)}${last}`,
      stderrTail: r.stderrTail,
    };
  }
  if (r.code === EXIT.ok) return { status: "success", exitCode: 0 };

  const last = failureReason(r.stderrTail);
  return {
    status: "failed",
    ...(r.code === null ? {} : { exitCode: r.code }),
    reason: `${what} failed (${describeExit(r)})${last === undefined ? "" : `: ${last}`}`,
    stderrTail: r.stderrTail,
  };
}

/**
 * A `run` step gets only the environment written in the step, not the daemon's.
 * Without PATH the program is looked up in the system default path.
 */
function runCommand(step: RunStep, options: RunOptions, log: (stream: LogStream, line: string) => void) {
  const [command, args] = step.shell ? ["/bin/sh", ["-c", step.command]] : [step.command[0]!, step.command.slice(1)];
  return runProcess({
    command,
    args,
    env: step.env,
    cwd: step.cwd,
    timeoutMs: step.timeoutMs,
    signal: options.signal,
    killGraceMs: options.killGraceMs,
    onLine: log,
  });
}

/**
 * `restic backup --json` and `restic restore --json` print progress, errors and a summary as JSON lines.
 * Progress is dropped, errors and the summary become readable log lines.
 */
function jsonOutput(log: (stream: LogStream, line: string) => void, describeSummary: (s: Summary) => string) {
  let summary: Record<string, unknown> | undefined;
  const onLine = (stream: "stdout" | "stderr", line: string) => {
    const msg = parseJsonLine(line);
    switch (msg?.message_type) {
      case "status":
      case "verbose_status":
        return;
      case "summary":
        summary = msg;
        log("stdout", describeSummary(msg as Summary));
        return;
      default:
        log(stream, readableJsonLine(line));
    }
  };
  return { onLine, summary: () => summary };
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

type Summary = Record<string, number | string | undefined>;

function backupSummary(s: Summary): string {
  const id = typeof s.snapshot_id === "string" ? s.snapshot_id.slice(0, 8) : "?";
  return (
    `snapshot ${id} saved: ${s.files_new ?? 0} new, ${s.files_changed ?? 0} changed, ` +
    `${s.files_unmodified ?? 0} unmodified files, ${formatBytes(Number(s.data_added ?? 0))} added`
  );
}

/** `files_restored` counts directories too; files already in place are `files_skipped`. */
function restoreSummary(s: Summary): string {
  const skipped = Number(s.files_skipped ?? 0);
  return (
    `restored ${s.files_restored ?? 0} files and directories (${formatBytes(Number(s.bytes_restored ?? 0))})` +
    (skipped > 0 ? `, ${skipped} already in place (${formatBytes(Number(s.bytes_skipped ?? 0))})` : "")
  );
}

/** One line of restic's `--json` output as text; lines that are not JSON stay as they are. */
function readableJsonLine(line: string): string {
  const msg = parseJsonLine(line);
  switch (msg?.message_type) {
    case "error": {
      const error = msg.error as { message?: string } | undefined;
      const item = typeof msg.item === "string" ? `${msg.item}: ` : "";
      return `error: ${item}${error?.message ?? JSON.stringify(msg.error)}`;
    }
    case "exit_error":
      return String(msg.message ?? line);
    default:
      return line;
  }
}

function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}
