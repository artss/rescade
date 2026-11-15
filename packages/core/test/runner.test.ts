import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runner, Store, type Cascade, type Config, type RunnerEvent, type Step } from "../src/index.js";
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
    expect(store.log(started.id, 1).map((l) => l.line)).toEqual(["Applying Policy: keep 7 daily snapshots"]);
    expect(store.log(started.id).some((l) => l.step === 0 && l.stream === "info")).toBe(true);

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
    expect(store.run(99)).toBeUndefined();
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
});
