import path from "node:path";
import { DEFAULT_REPO_CHECK_TIMEOUT_MS, execRestic, EXIT, failureReason, type ResticContext } from "./restic.js";

/** A snapshot as `restic snapshots --json` shows it; the summary fields come from restic 0.17+. */
export interface Snapshot {
  id: string;
  shortId: string;
  /** Epoch milliseconds. */
  time: number;
  hostname: string;
  username: string;
  paths: string[];
  tags: string[];
  parent?: string;
  /** Bytes of the files in the snapshot (`total_bytes_processed`). */
  size?: number;
  /** Files in the snapshot (`total_files_processed`). */
  files?: number;
  /** Bytes the backup added to the repo, before compression. */
  dataAdded?: number;
}

/** One file or directory in a snapshot, as `restic ls --json` shows it. */
export interface SnapshotEntry {
  name: string;
  /** "dir", "file", "symlink" and the other node types of restic. */
  type: string;
  path: string;
  size?: number;
  /** Epoch milliseconds. */
  mtime?: number;
  /** e.g. "drwxr-xr-x". */
  permissions?: string;
  /** Numeric owner as stored in the snapshot; restic keeps the names too, but `ls` does not show them. */
  uid?: number;
  gid?: number;
}

export interface SnapshotDir {
  snapshot: Snapshot;
  /** The listed path, normalized. */
  path: string;
  /** What is directly in `path`; for a file, only the file itself. */
  entries: SnapshotEntry[];
  /** More than MAX_DIR_ENTRIES: the rest is left out. */
  truncated: boolean;
}

/**
 * `not-found`: no such snapshot or path; `locked`: an exclusive lock (prune) did not go away in time;
 * `no-answer`: the repo did not answer within the check timeout.
 */
export type BrowseProblem = "not-found" | "locked" | "no-answer" | "failed" | "cancelled";

export type BrowseResult<T> = { ok: true; value: T } | { ok: false; problem: BrowseProblem; reason: string };

/**
 * Browsing takes no repo mutex of rescade (a long backup would hold it up). restic itself takes a shared lock,
 * which works next to a backup; against the exclusive lock of prune it waits this long, then gives up.
 */
export const BROWSE_RETRY_LOCK = "10s";
export const MAX_DIR_ENTRIES = 10_000;

/** Snapshot ids as rescade accepts them: hex, at least the 8 characters of a short id. */
export const SNAPSHOT_ID = /^[0-9a-f]{8,64}$/;

export const snapshotsArgs = (): string[] => ["snapshots", "--json", "--retry-lock", BROWSE_RETRY_LOCK];
export const lsArgs = (id: string, dir: string): string[] => ["ls", "--json", "--retry-lock", BROWSE_RETRY_LOCK, "--", id, dir];

/** All snapshots of the repo, newest first. */
export async function listSnapshots(ctx: ResticContext, repo: string): Promise<BrowseResult<Snapshot[]>> {
  const r = await call(ctx, repo, snapshotsArgs());
  if (!r.ok) return r;
  try {
    const list = JSON.parse(r.value.join("\n")) as unknown;
    if (!Array.isArray(list)) throw new Error("not an array");
    const snapshots = list.map((v) => toSnapshot(v as Record<string, unknown>));
    if (snapshots.some((s) => s === undefined)) throw new Error("bad snapshot");
    return { ok: true, value: (snapshots as Snapshot[]).sort((a, b) => b.time - a.time) };
  } catch {
    return { ok: false, problem: "failed", reason: 'unexpected output of "restic snapshots"' };
  }
}

/** What is directly in `dir` of the snapshot; restic reads only the trees on the way there. */
export async function listDir(ctx: ResticContext, repo: string, id: string, dir: string): Promise<BrowseResult<SnapshotDir>> {
  if (!SNAPSHOT_ID.test(id)) return { ok: false, problem: "not-found", reason: `"${id}" is not a snapshot id` };
  if (!dir.startsWith("/")) return { ok: false, problem: "not-found", reason: `"${dir}" is not an absolute path` };
  const want = path.posix.normalize(dir).replace(/(.)\/$/, "$1");

  let snapshot: Snapshot | undefined;
  let self: SnapshotEntry | undefined;
  const entries: SnapshotEntry[] = [];
  let truncated = false;
  let bad = false;
  const r = await call(ctx, repo, lsArgs(id, want), (line) => {
    const v = parseLine(line);
    if (v === undefined) return;
    if (v.message_type === "snapshot" || v.struct_type === "snapshot") {
      snapshot = toSnapshot(v);
      bad ||= snapshot === undefined;
      return;
    }
    const entry = toEntry(v);
    if (!entry) {
      bad = true;
    } else if (entry.path === want) {
      self = entry;
    } else if (entries.length < MAX_DIR_ENTRIES) {
      entries.push(entry);
    } else {
      truncated = true;
    }
  });
  if (!r.ok) return r;
  if (bad || !snapshot) return { ok: false, problem: "failed", reason: 'unexpected output of "restic ls"' };
  // restic lists nothing, without an error, for a path the snapshot does not have; the root has no node of its own
  if (want !== "/" && !self) return { ok: false, problem: "not-found", reason: `no ${want} in snapshot ${snapshot.shortId}` };
  if (self && self.type !== "dir") return { ok: true, value: { snapshot, path: want, entries: [self], truncated: false } };
  return { ok: true, value: { snapshot, path: want, entries, truncated } };
}

/** Runs restic and returns its stdout lines (or hands them to `onLine`), with failures sorted out. */
async function call(
  ctx: ResticContext,
  repo: string,
  args: string[],
  onLine?: (line: string) => void,
): Promise<BrowseResult<string[]>> {
  const stdout: string[] = [];
  const r = await execRestic(ctx, repo, args, {
    timeoutMs: ctx.repoCheckTimeoutMs ?? DEFAULT_REPO_CHECK_TIMEOUT_MS,
    onLine: (stream, line) => {
      if (stream !== "stdout") return;
      if (onLine) onLine(line);
      else stdout.push(line);
    },
  });
  if (r.cancelled) return { ok: false, problem: "cancelled", reason: "cancelled" };
  if (r.timedOut) {
    const why = r.stderrBeforeStop === undefined ? "" : `: ${readable(r.stderrBeforeStop)}`;
    return { ok: false, problem: "no-answer", reason: `the repo did not answer in time${why}` };
  }
  if (r.spawnError !== undefined) return { ok: false, problem: "failed", reason: `cannot start restic: ${r.spawnError}` };
  if (r.code === EXIT.ok) return { ok: true, value: stdout };

  const reason = failureReason(r.stderrTail, readable) ?? `restic ${args[0]} failed (exit code ${r.code})`;
  if (r.code === EXIT.lockFailed) return { ok: false, problem: "locked", reason };
  if (/no matching ID found/.test(reason)) return { ok: false, problem: "not-found", reason };
  return { ok: false, problem: "failed", reason };
}

/** With --json, restic's errors are JSON too; the first line of the message says enough. */
function readable(line: string): string {
  const v = parseLine(line);
  const message = v?.message_type === "exit_error" && typeof v.message === "string" ? v.message : line;
  return message.split("\n")[0]!.replace(/^Fatal: /, "");
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const epoch = (v: unknown): number | undefined => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

function toSnapshot(v: Record<string, unknown>): Snapshot | undefined {
  const id = str(v.id);
  const time = epoch(v.time);
  if (id === undefined || time === undefined) return undefined;
  const s: Snapshot = {
    id,
    shortId: str(v.short_id) ?? id.slice(0, 8),
    time,
    hostname: str(v.hostname) ?? "",
    username: str(v.username) ?? "",
    paths: strings(v.paths),
    tags: strings(v.tags),
  };
  const parent = str(v.parent);
  if (parent !== undefined) s.parent = parent;
  const summary = typeof v.summary === "object" && v.summary !== null ? (v.summary as Record<string, unknown>) : {};
  const size = num(summary.total_bytes_processed);
  const files = num(summary.total_files_processed);
  const dataAdded = num(summary.data_added);
  if (size !== undefined) s.size = size;
  if (files !== undefined) s.files = files;
  if (dataAdded !== undefined) s.dataAdded = dataAdded;
  return s;
}

function toEntry(v: Record<string, unknown>): SnapshotEntry | undefined {
  const name = str(v.name);
  const type = str(v.type);
  const p = str(v.path);
  if (name === undefined || type === undefined || p === undefined) return undefined;
  const e: SnapshotEntry = { name, type, path: p };
  const size = num(v.size);
  const mtime = epoch(v.mtime);
  const permissions = str(v.permissions);
  if (size !== undefined) e.size = size;
  if (mtime !== undefined) e.mtime = mtime;
  if (permissions !== undefined) e.permissions = permissions;
  const uid = num(v.uid);
  const gid = num(v.gid);
  if (uid !== undefined) e.uid = uid;
  if (gid !== undefined) e.gid = gid;
  return e;
}
