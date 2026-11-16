import type { BackupSet, BackupStep, CheckStep, PruneStep, Repo, Retention } from "../config/types.js";
import type { EnsureResult } from "./ensure.js";
import { runProcess, type ProcessResult, type Stream } from "./process.js";

/** restic exit codes (0.17+). */
export const EXIT = {
  ok: 0,
  fatal: 1,
  /** backup: some source files could not be read */
  partial: 3,
  repoMissing: 10,
  lockFailed: 11,
  wrongPassword: 12,
  interrupted: 130,
} as const;

export interface ResticContext {
  /** Path to the restic binary. */
  binary: string;
  /** Environment the restic processes start from (the daemon's or CLI's own). */
  env: Record<string, string | undefined>;
  repos: Record<string, Repo>;
  signal?: AbortSignal;
  killGraceMs?: number;
  /** Limit for `restic cat config`: restic retries an unreachable REST/S3 backend for many minutes. */
  repoCheckTimeoutMs?: number;
  /** Called with the outcome of every repo check (not for cancelled ones), to keep repo state. */
  onRepoChecked?: (repo: string, result: EnsureResult) => void;
}

export const DEFAULT_REPO_CHECK_TIMEOUT_MS = 2 * 60 * 1000;

/** restic passes on the stderr of ssh (sftp backend) and rclone with this prefix. */
const SUBPROCESS_LINE = /^subprocess ([\w.-]+): (.+)$/;

/**
 * The reason for a failed restic call: its last stderr line (through `readable`, for `--json` errors).
 * restic only says that the ssh or rclone connection closed, so their own last word is added:
 * without a tty ssh cannot ask about an unknown host key and fails with "Host key verification failed."
 */
export function failureReason(stderrTail: string[], readable: (line: string) => string = (l) => l): string | undefined {
  const lines = stderrTail.filter((l) => l.trim() !== "");
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  // with accept-new ssh announces every new host key; that is no reason for a failure
  const sub = [...lines].reverse().find((l) => SUBPROCESS_LINE.test(l) && !/: Warning: Permanently added /.test(l));
  if (sub === undefined || sub === last) return readable(last);
  const [, program, message] = SUBPROCESS_LINE.exec(sub)!;
  const hint = /Host key verification failed/.test(message!)
    ? "; the host key is unknown or has changed: check ~/.ssh/known_hosts of the user running rescade " +
      "(in the Docker image /var/lib/rescade/known_hosts)"
    : "";
  return `${readable(last)} (${program}: ${message}${hint})`;
}

/** Variables that pick a repository or its password; rescade sets these itself. */
export const OWN_VARS = new Set(
  ["REPOSITORY", "REPOSITORY_FILE", "PASSWORD", "PASSWORD_FILE", "PASSWORD_COMMAND"].flatMap((v) => [
    `RESTIC_${v}`,
    `RESTIC_FROM_${v}`,
  ]),
);

/**
 * Arguments and environment for one restic call on `target` (and `from` for copy / init --from-repo).
 * Repository locations and passwords go through the environment, never through arguments.
 */
export function resticCommand(
  baseEnv: Record<string, string | undefined>,
  target: Repo,
  args: string[],
  from?: Repo,
): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined && !OWN_VARS.has(k)) env[k] = v;
  }
  Object.assign(env, from?.env, target.env);
  env.RESTIC_REPOSITORY = target.path;
  env.RESTIC_PASSWORD = target.password;
  if (from) {
    env.RESTIC_FROM_REPOSITORY = from.path;
    env.RESTIC_FROM_PASSWORD = from.password;
  }
  const options = { ...from?.options, ...target.options };
  const global = Object.entries(options).flatMap(([k, v]) => ["-o", `${k}=${v}`]);
  return { args: [...global, ...args], env };
}

export function execRestic(
  ctx: ResticContext,
  target: string,
  args: string[],
  opts: { from?: string; timeoutMs?: number; onLine?: (stream: Stream, line: string) => void } = {},
): Promise<ProcessResult> {
  const repo = ctx.repos[target];
  if (!repo) throw new Error(`unknown repo "${target}"`);
  const from = opts.from === undefined ? undefined : ctx.repos[opts.from];
  if (opts.from !== undefined && !from) throw new Error(`unknown repo "${opts.from}"`);

  const cmd = resticCommand(ctx.env, repo, args, from);
  return runProcess({
    command: ctx.binary,
    args: cmd.args,
    env: cmd.env,
    timeoutMs: opts.timeoutMs,
    signal: ctx.signal,
    killGraceMs: ctx.killGraceMs,
    onLine: opts.onLine,
  });
}

/* ---------- arguments per command ---------- */

export const catConfigArgs = (): string[] => ["cat", "config"];

/** Lock files are read without taking a lock of our own. */
export const listLocksArgs = (): string[] => ["list", "locks", "--no-lock"];
export const catLockArgs = (id: string): string[] => ["cat", "lock", "--no-lock", id];

/** With `fromRepo`, the source comes from RESTIC_FROM_REPOSITORY. */
export const initArgs = (fromRepo: boolean): string[] => (fromRepo ? ["init", "--copy-chunker-params"] : ["init"]);

export function backupArgs(set: BackupSet, step: BackupStep): string[] {
  const args = ["backup", "--json"];
  if (set.oneFileSystem) args.push("--one-file-system");
  if (set.excludeCaches) args.push("--exclude-caches");
  for (const pattern of set.exclude) args.push("--exclude", pattern);
  for (const tag of new Set([...set.tags, ...step.tags])) args.push("--tag", tag);
  // "--" so that a path starting with "-" is not read as a flag
  args.push("--", ...set.include);
  return args;
}

const KEEP: Array<[keyof Retention, string]> = [
  ["last", "--keep-last"],
  ["hourly", "--keep-hourly"],
  ["daily", "--keep-daily"],
  ["weekly", "--keep-weekly"],
  ["monthly", "--keep-monthly"],
  ["yearly", "--keep-yearly"],
  ["within", "--keep-within"],
];

/** `restic forget` by the repo's policy, without --prune (that is a separate step). */
export function forgetArgs(retention: Retention): string[] {
  const args = ["forget"];
  for (const [key, flag] of KEEP) {
    const value = retention[key];
    if (value !== undefined) args.push(flag, String(value));
  }
  return args;
}

export function pruneArgs(step: PruneStep): string[] {
  return step.maxUnused === undefined ? ["prune"] : ["prune", "--max-unused", step.maxUnused];
}

export function checkArgs(step: CheckStep): string[] {
  return step.readDataSubset === undefined ? ["check"] : ["check", "--read-data-subset", step.readDataSubset];
}

/** The source comes from RESTIC_FROM_REPOSITORY. */
export const copyArgs = (): string[] => ["copy"];
