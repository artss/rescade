import { describe, expect, it } from "vitest";
import { RepoLocks, type LockResult } from "../src/index.js";

const owner = (runId: number, cascade = `c${runId}`) => ({ runId, cascade });
const wait = { wait: true };

function granted(r: LockResult): () => void {
  if (!r.ok) throw new Error(`expected the lock, got ${r.status}: ${r.reason}`);
  return r.release;
}

/** Lets pending promise callbacks run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("repo locks", () => {
  it("lets requests on different repos through and makes a request on a held repo wait", async () => {
    const locks = new RepoLocks();
    const releaseA = granted(await locks.acquire(["a"], owner(1), wait));
    granted(await locks.acquire(["b"], owner(2), wait));

    const reasons: string[] = [];
    let third: LockResult | undefined;
    void locks.acquire(["a", "c"], owner(3), { ...wait, onWait: (r) => reasons.push(r) }).then((r) => (third = r));
    await tick();
    expect(third).toBeUndefined();
    expect(reasons).toEqual(['repo "a" is busy: held by run 1 (cascade "c1")']);
    // nothing of a partial request is taken while it waits
    expect(locks.holder("c")).toBeUndefined();

    releaseA();
    await tick();
    expect(third?.ok).toBe(true);
    expect(locks.holder("a")).toEqual(owner(3));
    expect(locks.holder("c")).toEqual(owner(3));
  });

  it("gives up at once without wait (on-busy: skip)", async () => {
    const locks = new RepoLocks();
    granted(await locks.acquire(["b"], owner(1, "maintenance"), wait));
    expect(await locks.acquire(["a", "b"], owner(2), { wait: false })).toEqual({
      ok: false,
      status: "skipped",
      reason: 'repo "b" is busy: held by run 1 (cascade "maintenance")',
    });
    expect(locks.holder("a")).toBeUndefined();
  });

  it("serves waiters in order: a free repo is not taken from under an earlier waiter", async () => {
    const locks = new RepoLocks();
    const releaseA = granted(await locks.acquire(["a"], owner(1), wait));
    const order: number[] = [];
    // run 2 waits for a and b; run 3 only wants b, which is free, but run 2 asked first
    void locks.acquire(["a", "b"], owner(2), wait).then((r) => {
      order.push(2);
      setTimeout(granted(r), 10);
    });
    void locks.acquire(["b"], owner(3), wait).then((r) => {
      order.push(3);
      granted(r)();
    });
    expect(await locks.acquire(["b"], owner(4), { wait: false })).toMatchObject({
      reason: 'repo "b" is busy: run 2 (cascade "c2") is waiting for it',
    });

    await tick();
    expect(order).toEqual([]);
    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([2, 3]);
    expect(locks.holder("a")).toBeUndefined();
    expect(locks.holder("b")).toBeUndefined();
  });

  it("gives up after the wait timeout and lets later waiters go", async () => {
    const locks = new RepoLocks();
    granted(await locks.acquire(["a"], owner(1), wait));
    const first = locks.acquire(["a", "b"], owner(2), { wait: true, timeoutMs: 50 });
    const second = locks.acquire(["b"], owner(3), wait);
    expect(await first).toEqual({
      ok: false,
      status: "skipped",
      reason: 'repo "a" is busy: held by run 1 (cascade "c1"); gave up after waiting 50ms',
    });
    expect((await second).ok).toBe(true);
  });

  it("stops waiting when cancelled", async () => {
    const locks = new RepoLocks();
    granted(await locks.acquire(["a"], owner(1), wait));
    const ac = new AbortController();
    const pending = locks.acquire(["a"], owner(2), { wait: true, signal: ac.signal });
    ac.abort();
    expect(await pending).toEqual({ ok: false, status: "cancelled", reason: "cancelled" });
  });

  it("ignores a second release", async () => {
    const locks = new RepoLocks();
    const release = granted(await locks.acquire(["a"], owner(1), wait));
    release();
    granted(await locks.acquire(["a"], owner(2), wait));
    release();
    expect(locks.holder("a")).toEqual(owner(2));
  });
});
