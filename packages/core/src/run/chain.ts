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
  forgetArgs,
  pruneArgs,
  type ResticContext,
} from "../restic/restic.js";

export type StepStatus = "success" | "warning" | "failed" | "cancelled" | "skipped";
export type RunStatus = "success" | "warning" | "failed" | "cancelled";

export interface StepResult {
  index: number;
  type: Step["type"];
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
  chain: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number;
  steps: StepResult[];
}

/** "info" lines come from rescade itself, the others from the step's process. */
export type LogStream = "stdout" | "stderr" | "info";

export type RunEvent =
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
}

/** A short human description of a step, e.g. "copy system-local -> system-i1". */
export function describeStep(step: Step): string {
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

/** Runs the steps of one chain in order. Stops at the first failed step; the rest are skipped. */
export async function runChain(config: Config, chainName: string, options: RunOptions): Promise<RunResult> {
  const chain = config.chains[chainName];
  if (!chain) throw new Error(`unknown chain "${chainName}"`);

  const emit = options.onEvent ?? (() => {});
  const ctx: ResticContext = {
    binary: options.restic,
    env: options.env,
    repos: config.repos,
    signal: options.signal,
    killGraceMs: options.killGraceMs,
    repoCheckTimeoutMs: options.repoCheckTimeoutMs,
  };
  const startedAt = Date.now();
  const results: StepResult[] = [];
  let stopped = false;

  for (const [index, step] of chain.steps.entries()) {
    const label = describeStep(step);
    if (stopped || options.signal?.aborted) {
      const result: StepResult = { index, type: step.type, label, status: "skipped" };
      results.push(result);
      emit({ kind: "step-end", result });
      continue;
    }

    emit({ kind: "step-start", index, label });
    const log = (stream: LogStream, line: string) => emit({ kind: "log", index, stream, line });
    const stepStart = Date.now();
    let outcome: Outcome;
    try {
      outcome = await runStep(step, config, ctx, options, log);
    } catch (e) {
      outcome = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
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
    if (outcome.status === "failed" || outcome.status === "cancelled") stopped = true;
  }

  return { chain: chainName, status: overall(results), startedAt, finishedAt: Date.now(), steps: results };
}

function overall(steps: StepResult[]): RunStatus {
  const has = (s: StepStatus) => steps.some((r) => r.status === s);
  if (has("cancelled")) return "cancelled";
  if (has("failed")) return "failed";
  if (has("warning")) return "warning";
  return "success";
}

type Outcome = Pick<StepResult, "status" | "exitCode" | "reason" | "stderrTail" | "summary">;

async function runStep(
  step: Step,
  config: Config,
  ctx: ResticContext,
  options: RunOptions,
  log: (stream: LogStream, line: string) => void,
): Promise<Outcome> {
  const memo: EnsureMemo = new Map();
  const info = (line: string) => log("info", line);
  const ensure = (repo: string) => ensureRepo(ctx, repo, info, memo);
  const passLines = { onLine: log };

  switch (step.type) {
    case "backup": {
      const ready = await ensure(step.repo);
      if (!ready.ok) return notReady(ready);
      const set = config.sets[step.set];
      if (!set) return { status: "failed", reason: `unknown set "${step.set}"` };
      const output = backupOutput(log);
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
      return { ...fromProcess({ ...r, stderrTail: r.stderrTail.map(readableBackupLine) }, "restic backup"), summary };
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

  const last = r.stderrTail.filter((l) => l.trim() !== "").at(-1);
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
 * `restic backup --json` prints progress, errors and a summary as JSON lines.
 * Progress is dropped, errors and the summary become readable log lines.
 */
function backupOutput(log: (stream: LogStream, line: string) => void) {
  let summary: Record<string, unknown> | undefined;
  const onLine = (stream: "stdout" | "stderr", line: string) => {
    const msg = parseJsonLine(line);
    switch (msg?.message_type) {
      case "status":
      case "verbose_status":
        return;
      case "summary":
        summary = msg;
        log("stdout", readableBackupLine(line));
        return;
      default:
        log(stream, readableBackupLine(line));
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

/** One line of `restic backup --json` output as text; lines that are not JSON stay as they are. */
function readableBackupLine(line: string): string {
  const msg = parseJsonLine(line);
  switch (msg?.message_type) {
    case "summary": {
      const s = msg as Record<string, number | string | undefined>;
      const id = typeof s.snapshot_id === "string" ? s.snapshot_id.slice(0, 8) : "?";
      return (
        `snapshot ${id} saved: ${s.files_new ?? 0} new, ${s.files_changed ?? 0} changed, ` +
        `${s.files_unmodified ?? 0} unmodified files, ${formatBytes(Number(s.data_added ?? 0))} added`
      );
    }
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
