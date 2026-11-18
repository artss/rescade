import { formatDuration } from "../config/schema.js";
import {
  catConfigArgs,
  DEFAULT_REPO_CHECK_TIMEOUT_MS,
  execRestic,
  EXIT,
  failureReason,
  initArgs,
  type ResticContext,
} from "./restic.js";
import { readLocks, type RepoLockList } from "./lockfiles.js";
import type { ProcessResult } from "./process.js";

/** The parts of `restic cat config` rescade cares about. */
export interface RepoConfig {
  id: string;
  chunkerPolynomial: string;
}

export type RepoProblem = "unreachable" | "wrong-password" | "init-failed" | "error" | "cancelled";

type Failure = { ok: false; problem: RepoProblem; reason: string };

export type EnsureResult = { ok: true; config: RepoConfig; initialized: boolean; locks: RepoLockList } | Failure;

type ConfigResult = { ok: true; config: RepoConfig } | Failure;

/** Within one step a repo is checked once (copy may reach the same repo as target and as `from`). */
export type EnsureMemo = Map<string, Promise<EnsureResult>>;

const lastLine = (r: ProcessResult): string => failureReason(r.stderrTail) ?? "no output";

/**
 * Makes sure the repo exists: `restic cat config`, and on exit code 10 `restic init`
 * (from the `from` repo with its chunker parameters, after ensuring that one first).
 * Any other failure is reported; init is never attempted unless restic said the repo does not exist.
 * With `init: false` (restore) a missing repo is an error.
 */
export function ensureRepo(
  ctx: ResticContext,
  name: string,
  log: (line: string) => void,
  memo: EnsureMemo = new Map(),
  opts: { init?: boolean } = {},
): Promise<EnsureResult> {
  let result = memo.get(name);
  if (!result) {
    result = ensure(ctx, name, log, memo, opts.init ?? true).then((r) => {
      if (r.ok || r.problem !== "cancelled") ctx.onRepoChecked?.(name, r);
      return r;
    });
    memo.set(name, result);
  }
  return result;
}

async function ensure(
  ctx: ResticContext,
  name: string,
  log: (line: string) => void,
  memo: EnsureMemo,
  init: boolean,
): Promise<EnsureResult> {
  const repo = ctx.repos[name];
  if (!repo) return { ok: false, problem: "error", reason: `unknown repo "${name}"` };

  const first = await readConfig(ctx, name);
  if (first !== "missing") {
    if (!first.ok) return first;
    const locks = await readLocks(ctx, name);
    if (locks === "cancelled") return { ok: false, problem: "cancelled", reason: "cancelled" };
    return { ...first, initialized: false, locks };
  }
  if (!init) return { ok: false, problem: "error", reason: `repo "${name}" does not exist` };

  if (repo.from !== undefined) {
    const source = await ensureRepo(ctx, repo.from, log, memo);
    if (!source.ok) {
      return {
        ok: false,
        problem: source.problem === "cancelled" ? "cancelled" : "init-failed",
        reason: `cannot initialize repo "${name}" from "${repo.from}": ${source.reason}`,
      };
    }
    log(`repo "${name}" does not exist, initializing it with the chunker parameters of "${repo.from}"`);
  } else {
    log(`repo "${name}" does not exist, initializing it`);
  }

  const r = await execRestic(ctx, name, initArgs(repo.from !== undefined), {
    from: repo.from,
    onLine: (_stream, line) => log(line),
  });
  if (r.cancelled) return { ok: false, problem: "cancelled", reason: "cancelled" };
  if (r.code !== EXIT.ok) {
    return {
      ok: false,
      problem: "init-failed",
      reason: `restic init for repo "${name}" failed (${describeExit(r)}): ${lastLine(r)}`,
    };
  }

  const second = await readConfig(ctx, name);
  if (second === "missing") {
    return { ok: false, problem: "init-failed", reason: `repo "${name}" still does not exist after restic init` };
  }
  return second.ok ? { ...second, initialized: true, locks: { count: 0, locks: [] } } : second;
}

async function readConfig(ctx: ResticContext, name: string): Promise<ConfigResult | "missing"> {
  const stdout: string[] = [];
  const timeoutMs = ctx.repoCheckTimeoutMs ?? DEFAULT_REPO_CHECK_TIMEOUT_MS;
  const r = await execRestic(ctx, name, catConfigArgs(), {
    timeoutMs,
    onLine: (stream, line) => {
      if (stream === "stdout") stdout.push(line);
    },
  });

  if (r.cancelled) return { ok: false, problem: "cancelled", reason: "cancelled" };
  if (r.timedOut) {
    const last = r.stderrBeforeStop;
    return {
      ok: false,
      problem: "unreachable",
      reason: `repo "${name}" did not respond within ${formatDuration(timeoutMs)}` + (last === undefined ? "" : `: ${last}`),
    };
  }
  if (r.code === EXIT.repoMissing) return "missing";
  if (r.code === EXIT.wrongPassword) {
    return { ok: false, problem: "wrong-password", reason: `wrong password for repo "${name}"` };
  }
  if (r.code !== EXIT.ok) {
    return {
      ok: false,
      problem: r.spawnError === undefined ? "unreachable" : "error",
      reason: `cannot open repo "${name}" (${describeExit(r)}): ${r.spawnError ?? lastLine(r)}`,
    };
  }

  try {
    const parsed = JSON.parse(stdout.join("\n")) as { id?: unknown; chunker_polynomial?: unknown };
    if (typeof parsed.id === "string" && typeof parsed.chunker_polynomial === "string") {
      return { ok: true, config: { id: parsed.id, chunkerPolynomial: parsed.chunker_polynomial } };
    }
  } catch {
    // reported below
  }
  return { ok: false, problem: "error", reason: `unexpected output of "restic cat config" for repo "${name}"` };
}

export function describeExit(r: ProcessResult): string {
  if (r.spawnError !== undefined) return "not started";
  if (r.code !== null) return `exit code ${r.code}`;
  return `killed by ${r.signal ?? "a signal"}`;
}
