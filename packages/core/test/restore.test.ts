import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  literalPattern,
  restoreStep,
  runRestore,
  Runner,
  Store,
  type Cascade,
  type Config,
  type RunEvent,
  type RunnerEvent,
  type Step,
} from "../src/index.js";
import { baseConfig, FAKE_RESTIC, FakeState } from "./helpers/fake.js";

const ID = "c8b33f97" + "0".repeat(56);

let fake: FakeState;
let store: Store;
let restoreDir: string;
beforeEach(async () => {
  fake = await FakeState.create();
  store = await Store.open(":memory:");
  restoreDir = path.join(fake.dir, "restore");
  await mkdir(restoreDir);
  fake.writeRepo("/r/a", "pw-a");
  const nodes = ["/host", "/host/etc", "/host/etc/samba", "/host/home"].map((p) => ({ name: path.basename(p), type: "dir", path: p }));
  const files = ["/host/etc/samba/smb.conf", "/host/etc/hosts", "/host/etc/a[1]*", "/host/home/notes"].map((p) => ({
    name: path.basename(p),
    type: "file",
    path: p,
  }));
  fake.writeSnapshots("/r/a", [{ id: ID, short_id: ID.slice(0, 8), time: "2026-11-01T10:00:00Z", paths: ["/host"] }], {
    [ID]: [...nodes, ...files],
  });
});
afterEach(async () => {
  store.close();
  await fake.remove();
});

const restored = (rel: string) => path.join(restoreDir, "c8b33f97", rel);

describe("restore arguments", () => {
  it("escapes the pattern characters of restic in literal paths", () => {
    expect(literalPattern("/etc/a[1]*?.txt")).toBe("/etc/a\\[1\\]\\*\\?.txt");
    expect(literalPattern("/etc/back\\slash")).toBe("/etc/back\\\\slash");
    // "!" negates only at the start of a pattern, where an absolute path has "/"; $VAR is not expanded
    expect(literalPattern("/etc/!neg/$HOME")).toBe("/etc/!neg/$HOME");
  });

  it("restores into <dir>/<short id> and normalizes the paths", () => {
    expect(restoreStep({ repo: "a", snapshot: ID, paths: ["/etc/", "/etc", "/home/./x"] }, "/restore")).toEqual({
      type: "restore",
      repo: "a",
      snapshot: ID,
      paths: ["/etc", "/home/x"],
      target: "/restore/c8b33f97",
    });
    // "/" among the paths is the whole snapshot
    expect(restoreStep({ repo: "a", snapshot: "c8b33f97", paths: ["/etc", "/"] }, "/restore").paths).toEqual([]);
  });
});

describe("runRestore", () => {
  const run = (paths: string[], extra: Record<string, string> = {}, config: Config = baseConfig()) => {
    const events: RunEvent[] = [];
    const done = runRestore(config, restoreStep({ repo: "a", snapshot: "c8b33f97", paths }, restoreDir), {
      restic: FAKE_RESTIC,
      env: fake.env(extra),
      killGraceMs: 500,
      onEvent: (e) => events.push(e),
    });
    return { done, events };
  };

  it("restores the whole snapshot keeping its full paths", async () => {
    const { done, events } = run([]);
    const result = await done;
    expect(result).toMatchObject({ status: "success", steps: [{ type: "restore", status: "success", exitCode: 0 }] });
    expect(result.cascade).toBeUndefined();
    expect(result.steps[0]?.label).toBe(`restore c8b33f97 from a -> ${restoreDir}/c8b33f97`);
    expect(result.steps[0]?.summary).toMatchObject({ files_restored: 8 });
    expect(readFileSync(restored("host/etc/samba/smb.conf"), "utf8")).toBe("/host/etc/samba/smb.conf");
    expect(existsSync(restored("host/home/notes"))).toBe(true);
    expect(fake.trace()).toEqual(["cat config /r/a", "restore /r/a"]);
    const restore = fake.calls().find((c) => c.cmd === "restore")!;
    expect(restore.args).toEqual(["--json", "--target", `${restoreDir}/c8b33f97`, "--", "c8b33f97"]);
    // progress is dropped, the summary becomes a readable line
    const lines = events.flatMap((e) => (e.kind === "log" && e.stream !== "info" ? [e.line] : []));
    expect(lines).toEqual(["restored 8 files and directories (70 B)"]);
  });

  it("restores only the given paths, directories with everything below", async () => {
    const { done } = run(["/host/etc/samba", "/host/etc/a[1]*"]);
    expect((await done).status).toBe("success");
    const restore = fake.calls().find((c) => c.cmd === "restore")!;
    expect(restore.args).toEqual([
      "--json", "--target", `${restoreDir}/c8b33f97`,
      "--include", "/host/etc/samba", "--include", "/host/etc/a\\[1\\]\\*",
      "--", "c8b33f97",
    ]);
    expect(existsSync(restored("host/etc/samba/smb.conf"))).toBe(true);
    expect(existsSync(restored("host/etc/a[1]*"))).toBe(true);
    expect(existsSync(restored("host/etc/hosts"))).toBe(false);
    expect(existsSync(restored("host/home"))).toBe(false);
  });

  it("restores into an existing directory, overwriting what is there", async () => {
    await mkdir(restored("host/etc"), { recursive: true });
    writeFileSync(restored("host/etc/hosts"), "changed");
    writeFileSync(restored("host/etc/other"), "kept");
    expect((await run(["/host/etc/hosts"]).done).status).toBe("success");
    expect(readFileSync(restored("host/etc/hosts"), "utf8")).toBe("/host/etc/hosts");
    expect(readFileSync(restored("host/etc/other"), "utf8")).toBe("kept");
  });

  it("fails when the snapshot has none of the paths (restic exits with 0)", async () => {
    const result = await run(["/host/nope"]).done;
    expect(result).toMatchObject({
      status: "failed",
      reason: "restore c8b33f97 (/host/nope) from a -> " + `${restoreDir}/c8b33f97: snapshot c8b33f97 has none of the given paths`,
    });
  });

  it("fails on an unknown snapshot with restic's message", async () => {
    const result = await runRestore(baseConfig(), restoreStep({ repo: "a", snapshot: "deadbeef" }, restoreDir), {
      restic: FAKE_RESTIC,
      env: fake.env(),
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/restic restore failed \(exit code 1\): .*no matching ID found for prefix "deadbeef"/);
  });

  it("does not create a repo that does not exist", async () => {
    const result = await runRestore(baseConfig(), restoreStep({ repo: "c", snapshot: "c8b33f97" }, restoreDir), {
      restic: FAKE_RESTIC,
      env: fake.env(),
    });
    expect(result).toMatchObject({ status: "failed", steps: [{ reason: 'repo "c" does not exist' }] });
    expect(fake.readRepo("/r/c")).toBeUndefined();
    expect(fake.trace()).toEqual(["cat config /r/c"]);
  });

  it("is cancelled with SIGTERM", async () => {
    const ac = new AbortController();
    const done = runRestore(baseConfig(), restoreStep({ repo: "a", snapshot: "c8b33f97" }, restoreDir), {
      restic: FAKE_RESTIC,
      env: fake.env({ FAKE_RESTIC_HANG: "restore" }),
      killGraceMs: 500,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.kind === "log" && e.line === "working...") ac.abort();
      },
    });
    expect((await done).status).toBe("cancelled");
    expect(fake.sigtermReceived).toBe(true);
  });
});

describe("Runner.restore", () => {
  /** A run step that holds the given repos until `release` is called. */
  function holder(repos: string[]) {
    const flag = path.join(fake.dir, `release-${repos.join("-")}`);
    const script =
      "const f = process.argv[1]; console.log('holding'); const t = setInterval(() => require('fs').existsSync(f) && clearInterval(t), 10)";
    const step: Step = { type: "run", shell: false, command: [process.execPath, "-e", script, flag], env: {}, timeoutMs: 10_000, lock: repos };
    return { step, release: () => writeFileSync(flag, "") };
  }

  function setup(cascades: Record<string, Partial<Cascade> & { steps: Step[] }> = {}, dir: string | null = restoreDir) {
    const full: Config["cascades"] = {};
    for (const [name, c] of Object.entries(cascades)) full[name] = { schedule: [], onBusy: "skip", ...c };
    const runner = new Runner(baseConfig(full), {
      restic: FAKE_RESTIC,
      env: fake.env(),
      killGraceMs: 500,
      store,
      ...(dir === null ? {} : { restoreDir: dir }),
    });
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

  it("records a restore as a run without a cascade", async () => {
    const { runner, events } = setup();
    const started = runner.restore({ repo: "a", snapshot: "c8b33f97", paths: ["/host/etc/"] });
    const restore = { repo: "a", snapshot: "c8b33f97", paths: ["/host/etc"], target: `${restoreDir}/c8b33f97` };
    expect(started).toMatchObject({ restore, trigger: "manual", status: "running" });
    expect(started.cascade).toBeUndefined();
    await runner.idle();

    const run = store.run(started.id)!;
    expect(run).toMatchObject({ restore, status: "success", steps: [{ type: "restore", repo: "a", status: "success" }] });
    expect(run.steps[0]?.summary).toMatchObject({ files_restored: 5 });
    expect(store.log(started.id).some((l) => l.line.startsWith("restored 5 files"))).toBe(true);
    expect(events.flatMap((e) => (e.kind === "run" ? [e.run.status] : []))).toEqual(["running", "success"]);
  });

  it("waits for a repo held by a cascade; a later backup does not get ahead of it", async () => {
    const hold = holder(["a"]);
    const { runner } = setup({ maintenance: { steps: [hold.step] }, daily: { steps: [{ type: "backup", set: "s", repo: "a", tags: [] }] } });
    const m = runner.trigger("maintenance", "manual");
    await until(() => runner.locks.holder("a") !== undefined, "maintenance to take repo a");

    const r = runner.restore({ repo: "a", snapshot: "c8b33f97" });
    await until(() => store.run(r.id)?.status === "queued", "the restore to queue");
    expect(store.run(r.id)?.reason).toBe(`repo "a" is busy: held by run ${m.id} (cascade "maintenance")`);

    // the daily backup does not get ahead of the waiting restore
    const daily = runner.trigger("daily", "schedule");
    await until(() => store.run(daily.id)?.status === "skipped", "daily to skip");
    expect(store.run(daily.id)?.reason).toBe(
      `backup s -> a: repo "a" is busy: held by run ${m.id} (cascade "maintenance")`,
    );

    hold.release();
    await until(() => store.run(r.id)?.status !== "queued", "the restore to start");
    await runner.idle();
    expect(store.run(r.id)?.status).toBe("success");
  });

  it("holds the repo while it runs, can be cancelled, and is interrupted when the daemon stops", async () => {
    const daily: Cascade = { schedule: [], onBusy: "skip", steps: [{ type: "backup", set: "s", repo: "a", tags: [] }] };
    const runner = new Runner(baseConfig({ daily }), {
      restic: FAKE_RESTIC,
      env: fake.env({ FAKE_RESTIC_HANG: "restore" }),
      killGraceMs: 500,
      store,
      restoreDir,
    });
    const first = runner.restore({ repo: "a", snapshot: "c8b33f97" });
    await until(() => store.log(first.id).some((l) => l.line === "working..."), "restic restore to start");
    expect(runner.locks.holder("a")).toEqual({ runId: first.id });
    const backup = runner.trigger("daily", "schedule");
    await until(() => store.run(backup.id)?.status === "skipped", "the backup to skip");
    expect(store.run(backup.id)?.reason).toBe(`backup s -> a: repo "a" is busy: held by run ${first.id} (restore)`);
    expect(runner.cancel(first.id)).toBe(true);
    await runner.idle();
    expect(store.run(first.id)?.status).toBe("cancelled");

    const second = runner.restore({ repo: "a", snapshot: "c8b33f97" });
    await until(() => store.log(second.id).some((l) => l.line === "working..."), "restic restore to start");
    await runner.stop();
    expect(store.run(second.id)).toMatchObject({ status: "interrupted", steps: [{ status: "interrupted" }] });
  });

  it("refuses without a restore directory or for an unknown repo", () => {
    expect(() => setup({}, null).runner.restore({ repo: "a", snapshot: "c8b33f97" })).toThrow("restore is not enabled");
    expect(() => setup().runner.restore({ repo: "zz", snapshot: "c8b33f97" })).toThrow('unknown repo "zz"');
    expect(store.runs()).toEqual([]);
  });
});
