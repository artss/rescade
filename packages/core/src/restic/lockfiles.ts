import { catLockArgs, DEFAULT_REPO_CHECK_TIMEOUT_MS, execRestic, EXIT, failureReason, listLocksArgs, type ResticContext } from "./restic.js";

/** A restic lock file as `restic cat lock` shows it. */
export interface ResticLock {
  id: string;
  /** Epoch milliseconds; a live restic refreshes its locks every 5 minutes. */
  time: number;
  exclusive: boolean;
  hostname: string;
  username: string;
  pid: number;
  /** Older than restic's own limit for stale locks. */
  stale: boolean;
}

export interface RepoLockList {
  /** All lock files in the repo; details are read only for the first MAX_LOCK_DETAILS. */
  count: number;
  locks: ResticLock[];
  /** The locks could not be read; the repo itself answered. */
  error?: string;
}

/** restic treats a lock not refreshed for 30 minutes as stale. */
export const STALE_LOCK_MS = 30 * 60 * 1000;
export const MAX_LOCK_DETAILS = 10;

/**
 * Lock files left in the repo: by another restic that is still working or by one that died (stale).
 * Read before every step, when rescade's own restic processes do not hold the repo. Never removed here.
 */
export async function readLocks(ctx: ResticContext, name: string): Promise<RepoLockList | "cancelled"> {
  const timeoutMs = ctx.repoCheckTimeoutMs ?? DEFAULT_REPO_CHECK_TIMEOUT_MS;
  const call = async (args: string[]) => {
    const stdout: string[] = [];
    const r = await execRestic(ctx, name, args, {
      timeoutMs,
      onLine: (stream, line) => {
        if (stream === "stdout") stdout.push(line);
      },
    });
    const last = r.spawnError ?? r.stderrBeforeStop ?? failureReason(r.stderrTail) ?? "no output";
    return { r, stdout, failure: r.timedOut ? "no answer" : r.code === EXIT.ok ? undefined : last };
  };

  const list = await call(listLocksArgs());
  if (list.r.cancelled) return "cancelled";
  if (list.failure !== undefined) return { count: 0, locks: [], error: `cannot list locks: ${list.failure}` };
  const ids = list.stdout.map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}$/.test(l));

  const now = Date.now();
  let count = ids.length;
  const locks: ResticLock[] = [];
  for (const id of ids.slice(0, MAX_LOCK_DETAILS)) {
    const cat = await call(catLockArgs(id));
    if (cat.r.cancelled) return "cancelled";
    // the lock may be gone since the listing: its restic has finished
    if (cat.failure !== undefined) {
      count--;
      continue;
    }
    const lock = parseLock(id, cat.stdout.join("\n"), now);
    if (!lock) return { count, locks, error: `unexpected output of "restic cat lock ${id}"` };
    locks.push(lock);
  }
  return { count, locks };
}

function parseLock(id: string, text: string, now: number): ResticLock | undefined {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const time = typeof v.time === "string" ? Date.parse(v.time) : NaN;
    if (Number.isNaN(time)) return undefined;
    return {
      id,
      time,
      exclusive: v.exclusive === true,
      hostname: typeof v.hostname === "string" ? v.hostname : "",
      username: typeof v.username === "string" ? v.username : "",
      pid: typeof v.pid === "number" ? v.pid : 0,
      stale: now - time > STALE_LOCK_MS,
    };
  } catch {
    return undefined;
  }
}
