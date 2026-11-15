import { formatDuration } from "../config/schema.js";

/** Who holds or waits for a repo mutex; used in "busy" reasons. */
export interface LockOwner {
  runId: number;
  cascade: string;
}

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; status: "skipped" | "cancelled"; reason: string };

export interface AcquireOptions {
  /** false: give up at once when a repo is busy (`on-busy: skip`). */
  wait: boolean;
  /** With `wait`: give up after this long. Unlimited when absent. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called once if the request has to wait, with the reason. */
  onWait?: (reason: string) => void;
}

interface Waiter {
  repos: string[];
  owner: LockOwner;
  grant: () => void;
}

/**
 * One mutex per repo. A request takes all its repos at once or none of them, so a holder never waits
 * for another repo and there are no deadlocks. Waiters are served in order: a later request does not
 * take a repo an earlier waiter wants, even if it is free right now.
 */
export class RepoLocks {
  private readonly held = new Map<string, LockOwner>();
  private readonly queue: Waiter[] = [];

  holder(repo: string): LockOwner | undefined {
    return this.held.get(repo);
  }

  acquire(repos: string[], owner: LockOwner, options: AcquireOptions): Promise<LockResult> {
    const wanted = [...new Set(repos)].sort();
    if (this.available(wanted, this.queue.length)) return Promise.resolve({ ok: true, release: this.take(wanted, owner) });
    if (!options.wait) return Promise.resolve({ ok: false, status: "skipped", reason: this.busyReason(wanted) });
    if (options.signal?.aborted) return Promise.resolve({ ok: false, status: "cancelled", reason: "cancelled" });

    const { signal, timeoutMs } = options;
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const leave = (result: LockResult) => {
        cleanup();
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        // this waiter may have been the only thing keeping later ones out
        this.dispatch();
        resolve(result);
      };
      const onAbort = () => leave({ ok: false, status: "cancelled", reason: "cancelled" });
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const reason = `${this.busyReason(wanted)}; gave up after waiting ${formatDuration(timeoutMs)}`;
              leave({ ok: false, status: "skipped", reason });
            }, timeoutMs);
      const waiter: Waiter = {
        repos: wanted,
        owner,
        grant: () => {
          cleanup();
          resolve({ ok: true, release: this.take(wanted, owner) });
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      options.onWait?.(this.busyReason(wanted));
    });
  }

  /** Nobody holds the repos and none of the first `before` waiters wants them. */
  private available(repos: string[], before: number): boolean {
    return repos.every((r) => !this.held.has(r) && !this.queue.slice(0, before).some((w) => w.repos.includes(r)));
  }

  private take(repos: string[], owner: LockOwner): () => void {
    for (const r of repos) this.held.set(r, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const r of repos) this.held.delete(r);
      this.dispatch();
    };
  }

  private dispatch(): void {
    for (let i = 0; i < this.queue.length; ) {
      const waiter = this.queue[i]!;
      if (this.available(waiter.repos, i)) {
        this.queue.splice(i, 1);
        waiter.grant();
      } else {
        i++;
      }
    }
  }

  private busyReason(repos: string[]): string {
    for (const r of repos) {
      const owner = this.held.get(r);
      if (owner) return `repo "${r}" is busy: held by run ${owner.runId} (cascade "${owner.cascade}")`;
    }
    for (const r of repos) {
      const waiter = this.queue.find((w) => w.repos.includes(r));
      if (waiter) return `repo "${r}" is busy: run ${waiter.owner.runId} (cascade "${waiter.owner.cascade}") is waiting for it`;
    }
    return "repos are busy";
  }
}
