import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  rerunFrom,
  Runner,
  Store,
  warmUp,
  type Cascade,
  type Config,
  type RunnerEvent,
  type RunRecord,
  type Step,
  type StepRecord,
} from "../src/index.js";
import { baseConfig, FAKE_RESTIC, FakeState } from "./helpers/fake.js";

let fake: FakeState;
let store: Store;
beforeEach(async () => {
  fake = await FakeState.create();
  store = await Store.open(":memory:");
});
afterEach(async () => {
  store.close();
  await fake.remove();
});

const backupA: Step = { type: "backup", set: "s", repo: "a", tags: [] };
const backupC: Step = { type: "backup", set: "s", repo: "c", tags: [] };
const retainA: Step = { type: "retain", repo: "a" };

/** A run step that holds the given repos until `release` is called. */
function holder(repos: string[]) {
  const flag = path.join(fake.dir, `release-${repos.join("-")}`);
  const script = "const f = process.argv[1]; console.log('holding'); const t = setInterval(() => require('fs').existsSync(f) && clearInterval(t), 10)";
  const step: Step = { type: "run", shell: false, command: [process.execPath, "-e", script, flag], env: {}, timeoutMs: 10_000, lock: repos };
  return { step, release: () => writeFileSync(flag, "") };
}

function setup(cascades: Record<string, Partial<Cascade> & { steps: Step[] }>) {
  const full: Config["cascades"] = {};
  for (const [name, c] of Object.entries(cascades)) full[name] = { schedule: [], onBusy: "skip", ...c };
  const runner = new Runner(baseConfig(full), { restic: FAKE_RESTIC, env: fake.env(), killGraceMs: 500, store });
  const events: RunnerEvent[] = [];
  runner.subscribe((e) => events.push(e));
  return { runner, events };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runner", () => {
  it("records the run, its steps and logs in the store and reports them as events", async () => {
    const { runner, events } = setup({ daily: { steps: [backupA, retainA] } });
    const started = runner.trigger("daily", "manual");
    expect(started).toMatchObject({ cascade: "daily", trigger: "manual", status: "running" });
    await runner.idle();

    const run = store.run(started.id)!;
    expect(run).toMatchObject({ status: "success", cascade: "daily", trigger: "manual" });
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    expect(run.steps.map((s) => [s.label, s.status])).toEqual([
      ["backup s -> a", "success"],
      ["retain a", "success"],
    ]);
    expect(run.steps[0]?.summary).toMatchObject({ files_new: 2 });
    // the run page links the snapshot of a backup step to its repo
    expect(run.steps.map((s) => s.repo)).toEqual(["a", undefined]);
    expect(fake.readSnapshots("/r/a").map((s) => s.id)).toEqual([run.steps[0]?.summary?.snapshot_id]);
    expect(store.log(started.id, { step: 1 }).map((l) => l.line)).toEqual(["Applying Policy: keep 7 daily snapshots"]);
    expect(store.log(started.id).some((l) => l.step === 0 && l.stream === "info")).toBe(true);
    const logEvents = events.flatMap((e) => (e.kind === "log" ? [e.log] : []));
    expect(logEvents).toEqual(store.log(started.id));

    const runEvents = events.flatMap((e) => (e.kind === "run" ? [e.run.status] : []));
    expect(runEvents).toEqual(["running", "success"]);
    expect(events.filter((e) => e.kind === "step").map((e) => e.kind === "step" && e.step.status)).toEqual([
      "running", "success", "running", "success",
    ]);
    expect(runner.running()).toEqual([]);
  });

  it("does not start a cascade whose previous run is still in progress", async () => {
    const hold = holder([]);
    const { runner } = setup({ slow: { onBusy: "wait", steps: [hold.step] } });
    const first = runner.trigger("slow", "schedule");
    const second = runner.trigger("slow", "manual");
    expect(second).toMatchObject({ status: "skipped", reason: `run ${first.id} of this cascade is still in progress` });
    expect(runner.running().map((r) => r.id)).toEqual([first.id]);

    hold.release();
    await runner.idle();
    expect(store.runs().map((r) => [r.id, r.status])).toEqual([
      [second.id, "skipped"],
      [first.id, "success"],
    ]);
    // the next run starts normally
    expect(runner.trigger("slow", "manual").status).toBe("running");
    hold.release();
    await runner.idle();
  });

  it("skips a run whose step finds a repo busy (on-busy: skip)", async () => {
    const hold = holder(["a"]);
    const { runner } = setup({ maintenance: { steps: [hold.step] }, daily: { steps: [backupC, backupA, retainA] } });
    const m = runner.trigger("maintenance", "schedule");
    await until(() => runner.locks.holder("a") !== undefined, "maintenance to take repo a");

    const daily = runner.trigger("daily", "schedule");
    await until(() => store.run(daily.id)?.status !== "running", "daily to stop");
    const run = store.run(daily.id)!;
    expect(run.status).toBe("skipped");
    expect(run.reason).toBe(`backup s -> a: repo "a" is busy: held by run ${m.id} (cascade "maintenance")`);
    expect(run.steps.map((s) => s.status)).toEqual(["success", "skipped", "skipped"]);

    hold.release();
    await runner.idle();
    expect(store.run(m.id)?.status).toBe("success");
  });

  it("queues a step until its repo is free (on-busy: wait) while other repos stay usable", async () => {
    const hold = holder(["a"]);
    const { runner, events } = setup({
      maintenance: { steps: [hold.step] },
      daily: { onBusy: "wait", steps: [backupA] },
      other: { steps: [backupC] },
    });
    const m = runner.trigger("maintenance", "schedule");
    await until(() => runner.locks.holder("a") !== undefined, "maintenance to take repo a");

    const daily = runner.trigger("daily", "schedule");
    await until(() => store.run(daily.id)?.status === "queued", "daily to queue");
    expect(store.run(daily.id)).toMatchObject({
      reason: `repo "a" is busy: held by run ${m.id} (cascade "maintenance")`,
      steps: [{ status: "queued" }],
    });

    // a cascade on another repo is not held up
    const other = runner.trigger("other", "manual");
    await until(() => store.run(other.id)?.status === "success", "other to finish");
    expect(store.run(daily.id)?.status).toBe("queued");

    hold.release();
    await runner.idle();
    const run = store.run(daily.id)!;
    expect(run.status).toBe("success");
    expect(run.reason).toBeUndefined();
    const statuses = events.flatMap((e) => (e.kind === "run" && e.run.id === daily.id ? [e.run.status] : []));
    expect(statuses).toEqual(["running", "queued", "running", "success"]);
  });

  it("gives up waiting after wait-timeout", async () => {
    const hold = holder(["a"]);
    const { runner } = setup({
      maintenance: { steps: [hold.step] },
      daily: { onBusy: "wait", waitTimeoutMs: 100, steps: [backupA] },
    });
    runner.trigger("maintenance", "schedule");
    await until(() => runner.locks.holder("a") !== undefined, "maintenance to take repo a");
    const daily = runner.trigger("daily", "schedule");
    await until(() => store.run(daily.id)?.status === "skipped", "daily to give up");
    expect(store.run(daily.id)?.reason).toMatch(/gave up after waiting 100ms$/);
    hold.release();
    await runner.idle();
  });

  it("cancels a run, also one waiting for a repo", async () => {
    const hold = holder(["a"]);
    const { runner } = setup({ maintenance: { steps: [hold.step] }, daily: { onBusy: "wait", steps: [backupA] } });
    const m = runner.trigger("maintenance", "schedule");
    await until(() => runner.locks.holder("a") !== undefined, "maintenance to take repo a");
    const daily = runner.trigger("daily", "schedule");
    await until(() => store.run(daily.id)?.status === "queued", "daily to queue");

    expect(runner.cancel(daily.id)).toBe(true);
    expect(runner.cancel(m.id)).toBe(true);
    await runner.idle();
    expect(store.run(daily.id)?.status).toBe("cancelled");
    expect(store.run(m.id)?.status).toBe("cancelled");
    expect(runner.cancel(m.id)).toBe(false);
    expect(fake.calls()).toEqual([]);
  });

  it("starts new runs with a reloaded config", async () => {
    const { runner } = setup({ daily: { steps: [backupA] } });
    runner.setConfig(baseConfig({ daily: { schedule: [], onBusy: "skip", steps: [backupC] } }));
    const run = runner.trigger("daily", "manual");
    await runner.idle();
    expect(store.run(run.id)?.steps.map((s) => s.label)).toEqual(["backup s -> c"]);
    expect(() => runner.trigger("missing", "manual")).toThrow('unknown cascade "missing"');
  });
});

describe("store", () => {
  it("pages runs newest first and filters by cascade", () => {
    for (const cascade of ["a", "b", "a", "a"]) store.insertRun({ cascade, trigger: "manual", status: "success", startedAt: 1 });
    expect(store.runs().map((r) => r.id)).toEqual([4, 3, 2, 1]);
    expect(store.runs({ cascade: "a", limit: 2 }).map((r) => r.id)).toEqual([4, 3]);
    expect(store.runs({ cascade: "a", beforeId: 3 }).map((r) => r.id)).toEqual([1]);
    expect(store.runs({ cascade: "a", limit: 2, offset: 1 }).map((r) => r.id)).toEqual([3, 1]);
    expect(store.runs({ offset: 4 })).toEqual([]);
    expect([store.countRuns(), store.countRuns({ cascade: "a" }), store.countRuns({ cascade: "c" })]).toEqual([4, 3, 0]);
    expect(store.run(99)).toBeUndefined();
  });

  it("continues a log after a line id, also within a step", () => {
    const run = store.insertRun({ cascade: "daily", trigger: "manual", status: "running", startedAt: 0 });
    const other = store.insertRun({ cascade: "weekly", trigger: "manual", status: "running", startedAt: 0 });
    const add = (runId: number, step: number, line: string) => store.appendLog(runId, { step, ts: 0, stream: "stdout", line });
    const first = add(run.id, 0, "a");
    add(other.id, 0, "other");
    const second = add(run.id, 0, "b");
    add(run.id, 1, "c");
    expect(second.id).toBeGreaterThan(first.id);
    expect(store.log(run.id).map((l) => l.line)).toEqual(["a", "b", "c"]);
    expect(store.log(run.id, { after: first.id }).map((l) => l.line)).toEqual(["b", "c"]);
    expect(store.log(run.id, { step: 0, after: first.id })).toEqual([second]);
    expect(store.log(run.id, { after: second.id + 100 })).toEqual([]);
  });

  it("prunes old runs and old logs, keeping runs in progress and the latest run of each cascade", () => {
    const add = (cascade: string, finishedAt?: number) => {
      const run = store.insertRun({
        cascade,
        trigger: "schedule",
        status: finishedAt === undefined ? "running" : "success",
        startedAt: 0,
        ...(finishedAt === undefined ? {} : { finishedAt }),
      });
      store.saveStep({ runId: run.id, index: 0, type: "check", label: "check a", status: "success" });
      store.appendLog(run.id, { step: 0, ts: 0, stream: "stdout", line: `line of ${run.id}` });
      return run.id;
    };
    const ancient = add("daily", 10); // older than the history limit
    const old = add("daily", 500); // older than the log limit only
    const running = add("daily"); // still in progress, never finished
    const monthly = add("monthly", 10); // ancient, but the latest run of its cascade
    const fresh = add("daily", 950);

    expect(store.prune({ now: 1000, historyMs: 900, logMs: 100 })).toEqual({ runs: 1, logLines: 2 });
    expect(store.run(ancient)).toBeUndefined();
    expect(store.log(ancient)).toEqual([]);
    expect(store.run(old)?.steps).toHaveLength(1);
    expect(store.log(old)).toEqual([]);
    for (const id of [running, monthly, fresh]) expect(store.log(id)).toHaveLength(1);

    // without limits nothing goes
    expect(store.prune({ now: 10_000 })).toEqual({ runs: 0, logLines: 0 });
  });

  it("keeps the history in a file across reopening", async () => {
    const file = path.join(fake.dir, "rescade.db");
    const first = await Store.open(file);
    const run = first.insertRun({ cascade: "daily", trigger: "schedule", status: "running", startedAt: 5 });
    first.saveStep({ runId: run.id, index: 0, type: "check", label: "check a", status: "failed", stderrTail: ["x"] });
    first.updateRun(run.id, "failed", "check a: boom", 9);
    first.close();

    const second = await Store.open(file);
    expect(second.run(run.id)).toEqual({
      id: run.id,
      cascade: "daily",
      trigger: "schedule",
      status: "failed",
      reason: "check a: boom",
      startedAt: 5,
      finishedAt: 9,
      steps: [{ runId: run.id, index: 0, type: "check", label: "check a", status: "failed", stderrTail: ["x"] }],
    });
    second.close();
    expect(existsSync(file)).toBe(true);
  });

  it("upgrades a database of schema version 1", async () => {
    const file = path.join(fake.dir, "old.db");
    const { DatabaseSync } = await import("node:sqlite");
    (await Store.open(file)).close();
    const raw = new DatabaseSync(file);
    raw.exec(
      "ALTER TABLE steps DROP COLUMN repo; ALTER TABLE runs DROP COLUMN restore; ALTER TABLE runs DROP COLUMN rerun_of; " +
        "ALTER TABLE runs DROP COLUMN from_step; PRAGMA user_version = 1;",
    );
    raw.close();

    const upgraded = await Store.open(file);
    const run = upgraded.insertRun({ cascade: "daily", trigger: "schedule", status: "running", startedAt: 5 });
    upgraded.saveStep({ runId: run.id, index: 0, type: "backup", label: "backup s -> a", repo: "a", status: "running" });
    expect(upgraded.run(run.id)?.steps[0]?.repo).toBe("a");
    upgraded.close();
  });

  it("upgrades a database of schema version 2 and keeps its runs", async () => {
    const file = path.join(fake.dir, "v2.db");
    const { DatabaseSync } = await import("node:sqlite");
    const old = await Store.open(file);
    const before = old.insertRun({ cascade: "daily", trigger: "schedule", status: "success", startedAt: 5, finishedAt: 6 });
    old.close();
    const raw = new DatabaseSync(file);
    raw.exec(
      "ALTER TABLE runs DROP COLUMN restore; ALTER TABLE runs DROP COLUMN rerun_of; ALTER TABLE runs DROP COLUMN from_step; " +
        "PRAGMA user_version = 2;",
    );
    raw.close();

    const upgraded = await Store.open(file);
    expect(upgraded.run(before.id)).toEqual({ ...before, steps: [] });
    const restore = { repo: "a", snapshot: "c8b33f97", paths: ["/etc"], target: "/restore/c8b33f97" };
    const run = upgraded.insertRun({ restore, trigger: "manual", status: "running", startedAt: 7 });
    expect(upgraded.run(run.id)).toEqual({ id: run.id, restore, trigger: "manual", status: "running", startedAt: 7, steps: [] });
    expect(upgraded.runs().map((r) => r.cascade)).toEqual([undefined, "daily"]);
    upgraded.close();
  });

  it("upgrades a database of schema version 3 and records reruns", async () => {
    const file = path.join(fake.dir, "v3.db");
    const { DatabaseSync } = await import("node:sqlite");
    const old = await Store.open(file);
    const before = old.insertRun({ cascade: "daily", trigger: "schedule", status: "failed", startedAt: 5, finishedAt: 6 });
    old.close();
    const raw = new DatabaseSync(file);
    raw.exec("ALTER TABLE runs DROP COLUMN rerun_of; ALTER TABLE runs DROP COLUMN from_step; PRAGMA user_version = 3;");
    raw.close();

    const upgraded = await Store.open(file);
    expect(upgraded.run(before.id)).toEqual({ ...before, steps: [] });
    const run = upgraded.insertRun({ cascade: "daily", trigger: "manual", rerunOf: before.id, fromStep: 2, status: "running", startedAt: 7 });
    expect(upgraded.run(run.id)).toMatchObject({ rerunOf: before.id, fromStep: 2 });
    upgraded.close();
  });
});

describe("rerun", () => {
  /** A run step that fails until `fix` is called. */
  function flaky() {
    const flag = path.join(fake.dir, "fixed");
    const script = "process.exit(require('fs').existsSync(process.argv[1]) ? 0 : 1)";
    const step: Step = { type: "run", name: "flaky", shell: false, command: [process.execPath, "-e", script, flag], env: {}, timeoutMs: 10_000, lock: [] };
    return { step, fix: () => writeFileSync(flag, "") };
  }

  it("starts a new run from the failed step and leaves the old one as it was", async () => {
    const f = flaky();
    const { runner } = setup({ daily: { steps: [backupA, f.step, retainA] } });
    const first = runner.trigger("daily", "schedule");
    await runner.idle();
    const failed = store.run(first.id)!;
    expect(failed.steps.map((s) => s.status)).toEqual(["success", "failed", "skipped"]);

    f.fix();
    const callsBefore = fake.trace().length;
    const second = runner.rerun(first.id);
    expect(second).toMatchObject({ cascade: "daily", trigger: "manual", rerunOf: first.id, fromStep: 1, status: "running" });
    await runner.idle();

    expect(store.run(first.id)).toEqual(failed);
    const rerun = store.run(second.id)!;
    expect(rerun).toMatchObject({ status: "success", rerunOf: first.id, fromStep: 1 });
    // the steps keep their indexes in the cascade; the done backup is neither run nor recorded
    expect(rerun.steps.map((s) => [s.index, s.label, s.status])).toEqual([
      [1, "flaky", "success"],
      [2, "retain a", "success"],
    ]);
    expect(fake.trace().slice(callsBefore).some((c) => c.includes("backup"))).toBe(false);
    expect(store.runs({ cascade: "daily" }).map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("starts from the first step without a record, and counts a warning as done", async () => {
    const { runner } = setup({ daily: { steps: [backupA, retainA, backupC] } });
    const run = store.insertRun({ cascade: "daily", trigger: "schedule", status: "interrupted", startedAt: 1, finishedAt: 2 });
    store.saveStep({ runId: run.id, index: 0, type: "backup", label: "backup s -> a", status: "warning" });
    store.saveStep({ runId: run.id, index: 1, type: "retain", label: "retain a", status: "success" });
    const second = runner.rerun(run.id);
    expect(second.fromStep).toBe(2);
    await runner.idle();
    expect(store.run(second.id)!.steps.map((s) => s.label)).toEqual(["backup s -> c"]);
  });

  it("refuses runs that cannot be rerun", async () => {
    const { runner } = setup({ daily: { steps: [backupA, retainA] }, other: { steps: [backupC] } });
    const insert = (status: RunRecord["status"], steps: Array<[string, StepRecord["status"]]>, cascade = "daily") => {
      const run = store.insertRun({ cascade, trigger: "schedule", status, startedAt: 1, finishedAt: 2 });
      steps.forEach(([label, s], index) => store.saveStep({ runId: run.id, index, type: "backup", label, status: s }));
      return store.run(run.id)!;
    };
    const config = baseConfig({
      daily: { schedule: [], onBusy: "skip", steps: [backupA, retainA] },
    });

    expect(rerunFrom(insert("success", [["backup s -> a", "success"]]), config)).toMatch(/is success, only a failed/);
    expect(rerunFrom(insert("running", [["backup s -> a", "running"]]), config)).toMatch(/is running/);
    expect(rerunFrom(insert("skipped", []), config)).toMatch(/ran no steps/);
    expect(rerunFrom(insert("failed", [["backup s -> a", "success"], ["retain a", "success"]]), config)).toMatch(/all steps .* are done/);
    const changed = insert("failed", [["backup s -> b", "success"], ["retain a", "failed"]]);
    expect(rerunFrom(changed, config)).toBe(
      `the steps of cascade "daily" changed since run ${changed.id}: step 1 was "backup s -> b", now "backup s -> a"`,
    );
    expect(rerunFrom(insert("failed", [["x", "failed"]], "gone"), config)).toBe('cascade "gone" is no longer in the config');
    // the failed step itself may have changed: it is usually what was fixed
    expect(rerunFrom(insert("failed", [["backup s -> a", "success"], ["old label", "failed"]]), config)).toBe(1);
    // a step skipped because its repos were busy
    expect(rerunFrom(insert("skipped", [["backup s -> a", "success"], ["retain a", "skipped"]]), config)).toBe(1);

    const restore = store.insertRun({
      restore: { repo: "a", snapshot: "c8b33f97", paths: [], target: "/r" },
      trigger: "manual",
      status: "failed",
      startedAt: 1,
    });
    expect(() => runner.rerun(restore.id)).toThrow("a restore cannot be rerun");
    expect(() => runner.rerun(999)).toThrow("no run 999");
  });

  it("is recorded as skipped while the cascade is still running", async () => {
    const hold = holder([]);
    const { runner } = setup({ daily: { steps: [backupA, hold.step] } });
    const old = store.insertRun({ cascade: "daily", trigger: "schedule", status: "failed", startedAt: 1, finishedAt: 2 });
    store.saveStep({ runId: old.id, index: 0, type: "backup", label: "backup s -> a", status: "failed" });
    const running = runner.trigger("daily", "manual");
    const second = runner.rerun(old.id);
    expect(second).toMatchObject({ status: "skipped", rerunOf: old.id, fromStep: 0, reason: `run ${running.id} of this cascade is still in progress` });
    hold.release();
    await runner.idle();
  });
});

describe("stopping and repo state", () => {
  it("interrupts runs in progress on stop and refuses new ones", async () => {
    const hold = holder(["a"]);
    const { runner } = setup({ maintenance: { steps: [hold.step, retainA] }, daily: { onBusy: "wait", steps: [backupA] } });
    const m = runner.trigger("maintenance", "schedule");
    await until(() => runner.locks.holder("a") !== undefined, "maintenance to take repo a");
    const daily = runner.trigger("daily", "schedule");
    await until(() => store.run(daily.id)?.status === "queued", "daily to queue");

    await runner.stop();
    expect(runner.isStopping).toBe(true);
    expect(store.run(m.id)).toMatchObject({
      status: "interrupted",
      reason: "the daemon stopped during the run",
      steps: [{ status: "interrupted" }, { status: "skipped" }],
    });
    expect(store.run(daily.id)?.status).toBe("interrupted");
    expect(() => runner.trigger("daily", "manual")).toThrow("the runner is stopping");
  });

  it("reports every repo check", async () => {
    const { runner, events } = setup({ copy: { steps: [{ type: "copy", from: "a", to: "b" }] } });
    runner.trigger("copy", "manual");
    await runner.idle();
    const repos = events.flatMap((e) => (e.kind === "repo" ? [[e.repo, e.result.ok]] : []));
    expect(repos.sort()).toEqual([["a", true], ["b", true]]);
  });

  it("marks runs and steps left unfinished as interrupted", () => {
    const left = store.insertRun({ cascade: "c", trigger: "schedule", status: "queued", startedAt: 1 });
    store.saveStep({ runId: left.id, index: 0, type: "check", label: "check a", status: "running" });
    const done = store.insertRun({ cascade: "c", trigger: "schedule", status: "success", startedAt: 1, finishedAt: 2 });
    expect(store.markInterrupted(10)).toMatchObject([{ id: left.id, status: "interrupted", reason: "the daemon stopped during the run" }]);
    expect(store.run(left.id)).toMatchObject({ status: "interrupted", finishedAt: 10, steps: [{ status: "interrupted" }] });
    expect(store.run(done.id)?.status).toBe("success");
  });

  it("finds the previous outcome of a cascade, ignoring skipped and cancelled runs", () => {
    const at = { trigger: "schedule" as const, startedAt: 1, finishedAt: 2 };
    store.insertRun({ cascade: "c", status: "failed", ...at });
    store.insertRun({ cascade: "other", status: "success", ...at });
    store.insertRun({ cascade: "c", status: "skipped", ...at });
    store.insertRun({ cascade: "c", status: "cancelled", ...at });
    const last = store.insertRun({ cascade: "c", status: "success", ...at });
    expect(store.previousOutcome("c", last.id)).toBe("failed");
    expect(store.previousOutcome("c", last.id + 1)).toBe("success");
    expect(store.previousOutcome("other", 1)).toBeUndefined();
  });
});

describe("warm-up", () => {
  const ctx = () => ({ binary: FAKE_RESTIC, env: fake.env(), killGraceMs: 500 });

  it("initializes missing repos, sources first, and reports chunker mismatches", async () => {
    fake.writeRepo("/r/a", "pw-a", "aaaa");
    const config = baseConfig();
    // c claims to be created from a, but already exists with other chunker parameters
    config.repos.c = { ...config.repos.c!, from: "a" };
    fake.writeRepo("/r/c", "pw-c", "cccc");
    const lines: string[] = [];
    const r = await warmUp(config, ctx(), (repo, line) => lines.push(`${repo}: ${line}`));
    expect([...r.results.keys()]).toEqual(["a", "b", "c"]);
    expect([...r.results.values()].every((x) => x.ok)).toBe(true);
    expect(fake.readRepo("sftp:host:/r/b")?.chunker_polynomial).toBe("aaaa");
    expect(lines).toContain('b: repo "b" does not exist, initializing it with the chunker parameters of "a"');
    expect(r.fatal).toEqual([]);
    expect(r.mismatches).toEqual([
      'repo "c" was created from "a" but its chunker parameters differ (cccc vs aaaa); copied data will not deduplicate',
    ]);
  });

  it("reads the lock files left in existing repos and tells stale ones", async () => {
    fake.writeRepo("/r/a", "pw-a");
    fake.writeRepo("/r/c", "pw-c");
    const at = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    const lock = { exclusive: true, hostname: "nas", username: "root", pid: 42, uid: 0, gid: 0 };
    fake.writeLocks("/r/a", [
      { id: "1".repeat(64), time: at(60 * 60_000), ...lock },
      { id: "2".repeat(64), time: at(60_000), ...lock, exclusive: false },
    ]);
    fake.writeLocks("/r/c", [{ id: "3".repeat(64), time: "not a time" }]);
    const r = await warmUp(baseConfig(), ctx(), () => {});

    const a = r.results.get("a");
    expect(a?.ok && a.locks).toEqual({
      count: 2,
      locks: [
        { id: "1".repeat(64), time: expect.any(Number), exclusive: true, hostname: "nas", username: "root", pid: 42, stale: true },
        { id: "2".repeat(64), time: expect.any(Number), exclusive: false, hostname: "nas", username: "root", pid: 42, stale: false },
      ],
    });
    // b was just created: nothing to read
    const b = r.results.get("b");
    expect(b?.ok && b.locks).toEqual({ count: 0, locks: [] });
    expect(fake.calls().filter((c) => c.repo === "sftp:host:/r/b").map((c) => c.cmd)).toEqual(["cat", "init", "cat"]);
    const c = r.results.get("c");
    expect(c?.ok && c.locks).toEqual({ count: 1, locks: [], error: `unexpected output of "restic cat lock ${"3".repeat(64)}"` });
    expect(fake.calls().find((x) => x.cmd === "cat" && x.args[0] === "lock" && x.repo === "/r/a")?.args).toEqual(["lock", "--no-lock", "1".repeat(64)]);
  });

  it("keeps a repo usable when its locks cannot be listed", async () => {
    fake.writeRepo("/r/a", "pw-a");
    const r = await warmUp(baseConfig(), { ...ctx(), env: fake.env({ FAKE_RESTIC_EXIT_LIST: "1" }) }, () => {});
    expect(r.results.get("a")).toMatchObject({
      ok: true,
      locks: { count: 0, locks: [], error: "cannot list locks: Fatal: fake failure in list" },
    });
    expect(r.fatal).toEqual([]);
  });

  it("treats a wrong password as fatal and an unreachable repo as not", async () => {
    fake.writeRepo("/r/a", "other");
    const r = await warmUp(baseConfig(), { ...ctx(), env: fake.env({ FAKE_RESTIC_UNREACHABLE: "/r/c" }) }, () => {});
    expect(r.fatal).toEqual(['repo "a": wrong password for repo "a"', 'repo "b": cannot initialize repo "b" from "a": wrong password for repo "a"']);
    expect(r.results.get("c")).toMatchObject({ ok: false, problem: "unreachable" });
  });
});
