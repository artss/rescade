import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoLocks, runCascade, type Cascade, type RunEvent, type RunOptions, type Step } from "../src/index.js";
import { baseConfig, FAKE_RESTIC, FakeState } from "./helpers/fake.js";

let fake: FakeState;
beforeEach(async () => {
  fake = await FakeState.create();
});
afterEach(async () => {
  await fake.remove();
});

const cascade = (...steps: Step[]): Cascade => ({ schedule: [], onBusy: "skip", steps });
const backup: Step = { type: "backup", set: "s", repo: "a", tags: [] };
const retainA: Step = { type: "retain", repo: "a" };
const checkA: Step = { type: "check", repo: "a" };
const copyAB: Step = { type: "copy", from: "a", to: "b" };

async function run(steps: Step[], env: Record<string, string> = {}, extra: Partial<RunOptions> = {}) {
  const events: RunEvent[] = [];
  const result = await runCascade(baseConfig({ c: cascade(...steps) }), "c", {
    restic: FAKE_RESTIC,
    env: fake.env(env),
    killGraceMs: 500,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const logs = events.flatMap((e) => (e.kind === "log" ? [`${e.index} ${e.stream}: ${e.line}`] : []));
  return { result, events, logs, statuses: result.steps.map((s) => s.status) };
}

describe("running a cascade", () => {
  it("initializes missing repos and runs every step", async () => {
    const { result, logs } = await run([backup, retainA, checkA, copyAB, { type: "retain", repo: "b" }]);

    expect(result.status).toBe("success");
    expect(result.steps.map((s) => s.label)).toEqual([
      "backup s -> a", "retain a", "check a", "copy a -> b", "retain b",
    ]);
    expect(fake.trace()).toEqual([
      "cat config /r/a", "init /r/a", "cat config /r/a", "backup /r/a",
      "cat config /r/a", "forget /r/a",
      "cat config /r/a", "check /r/a",
      "cat config /r/a", "cat config sftp:host:/r/b", "init sftp:host:/r/b", "cat config sftp:host:/r/b", "copy sftp:host:/r/b",
      "cat config sftp:host:/r/b", "forget sftp:host:/r/b",
    ]);
    expect(logs).toContain('0 info: repo "a" does not exist, initializing it');
    expect(logs).toContain('3 info: repo "b" does not exist, initializing it with the chunker parameters of "a"');

    // b got a's chunker parameters
    expect(fake.readRepo("sftp:host:/r/b")?.chunker_polynomial).toBe(fake.readRepo("/r/a")?.chunker_polynomial);
    const calls = fake.calls();
    const initB = calls.find((c) => c.cmd === "init" && c.repo === "sftp:host:/r/b")!;
    expect(initB).toMatchObject({ args: ["--copy-chunker-params"], from: "/r/a", hasFromPassword: true });
    expect(calls.find((c) => c.cmd === "copy")).toMatchObject({ from: "/r/a", hasPassword: true, hasFromPassword: true });
    // passwords never appear in arguments
    expect(JSON.stringify(calls.map((c) => [c.args, c.options]))).not.toMatch(/pw-/);
  });

  it("passes the set and retention policy to restic and reports the backup summary", async () => {
    fake.writeRepo("/r/a", "pw-a");
    const { result, logs } = await run([backup, { type: "retain", repo: "b" }]);
    const calls = fake.calls();
    expect(calls.find((c) => c.cmd === "backup")?.args).toEqual([
      "--json", "--one-file-system", "--exclude", "**/venv", "--tag", "auto", "--", "/etc", "/home",
    ]);
    expect(calls.find((c) => c.cmd === "forget")?.args).toEqual(["--keep-weekly", "4", "--keep-within", "1y"]);
    expect(result.steps[0]?.summary).toMatchObject({ files_new: 2, data_added: 2048 });
    expect(logs.some((l) => /^0 stdout: snapshot \w{8} saved: 2 new, 1 changed, 10 unmodified files, 2\.0 KiB added$/.test(l))).toBe(true);
    // progress lines are dropped
    expect(logs.some((l) => l.includes("percent_done"))).toBe(false);
  });

  it("treats backup exit code 3 as a warning and goes on", async () => {
    const { result, statuses, logs } = await run([backup, retainA], { FAKE_RESTIC_EXIT_BACKUP: "3" });
    expect(statuses).toEqual(["warning", "success"]);
    expect(result.status).toBe("warning");
    expect(result.steps[0]).toMatchObject({ exitCode: 3, reason: expect.stringContaining("could not be read") });
    expect(result.steps[0]?.summary).toBeDefined();
    expect(logs).toContain("0 stderr: error: /secret: permission denied");
  });

  it("turns restic's JSON errors into readable text in the reason", async () => {
    const { result, logs } = await run([backup], { FAKE_RESTIC_EXIT_BACKUP: "1" });
    expect(result.steps[0]).toMatchObject({
      status: "failed",
      reason: "restic backup failed (exit code 1): Fatal: fake failure in backup",
      stderrTail: ["Fatal: fake failure in backup"],
    });
    expect(logs.at(-1)).toBe("0 stderr: Fatal: fake failure in backup");
  });

  it("stops at a failed step, with the exit code and stderr in the reason", async () => {
    const { result, statuses, events } = await run([backup, checkA, retainA], { FAKE_RESTIC_EXIT_CHECK: "1" });
    expect(statuses).toEqual(["success", "failed", "skipped"]);
    expect(result.status).toBe("failed");
    expect(result.steps[1]).toMatchObject({
      exitCode: 1,
      reason: "restic check failed (exit code 1): Fatal: fake failure in check",
      stderrTail: ["Fatal: fake failure in check"],
    });
    expect(result.steps[2]?.startedAt).toBeUndefined();
    expect(events.filter((e) => e.kind === "step-start")).toHaveLength(2);
    expect(fake.trace().filter((t) => t.startsWith("forget"))).toEqual([]);
  });

  it("gives up on a repo that does not answer, without trying init", async () => {
    // restic keeps retrying an unreachable REST/S3 backend for minutes
    fake.writeRepo("/r/a", "pw-a");
    const { result, statuses } = await run([backup, retainA], { FAKE_RESTIC_HANG: "cat" }, { repoCheckTimeoutMs: 300 });
    expect(statuses).toEqual(["failed", "skipped"]);
    expect(result.steps[0]?.reason).toBe('repo "a" did not respond within 300ms');
    expect(fake.trace()).toEqual(["cat config /r/a"]);
  });

  it("fails on a wrong password without trying init", async () => {
    fake.writeRepo("/r/a", "another password");
    const { result } = await run([backup]);
    expect(result.steps[0]).toMatchObject({ status: "failed", reason: 'wrong password for repo "a"' });
    expect(fake.trace()).toEqual(["cat config /r/a"]);
  });

  it("never initializes an unreachable repo", async () => {
    fake.writeRepo("/r/a", "pw-a");
    const { result } = await run([copyAB], { FAKE_RESTIC_UNREACHABLE: "sftp:host:/r/b" });
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.reason).toMatch(/^cannot open repo "b" \(exit code 1\): Fatal: unable to open repository .*no route to host$/);
    expect(fake.trace()).toEqual(["cat config /r/a", "cat config sftp:host:/r/b"]);
  });

  it("fails the step when init fails", async () => {
    const { result } = await run([backup], { FAKE_RESTIC_EXIT_INIT: "1" });
    expect(result.steps[0]).toMatchObject({
      status: "failed",
      reason: 'restic init for repo "a" failed (exit code 1): Fatal: fake failure in init',
    });
    expect(fake.trace()).toEqual(["cat config /r/a", "init /r/a"]);
  });

  it("does not init a repo whose source cannot be opened", async () => {
    // a exists with a different password, so b cannot be created from it
    fake.writeRepo("/r/a", "wrong");
    const { result } = await run([{ type: "check", repo: "b" }]);
    expect(result.steps[0]?.reason).toBe('cannot initialize repo "b" from "a": wrong password for repo "a"');
    expect(fake.trace()).toEqual(["cat config sftp:host:/r/b", "cat config /r/a"]);
  });

  it("fails when restic cannot be started", async () => {
    const { result } = await run([backup], {}, { restic: "/nonexistent/restic" });
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.reason).toMatch(/^cannot open repo "a" \(not started\): .*ENOENT/);
  });
});

describe("chunker parameters before copy", () => {
  it("warns about differing parameters and still copies", async () => {
    fake.writeRepo("/r/a", "pw-a", "aaaaaaaaaaaaaa");
    fake.writeRepo("sftp:host:/r/b", "pw-b", "bbbbbbbbbbbbbb");
    const { result, statuses, logs } = await run([copyAB, retainA]);
    expect(statuses).toEqual(["warning", "success"]);
    expect(result.steps[0]?.reason).toBe(
      'chunker parameters differ: "a" has aaaaaaaaaaaaaa, "b" has bbbbbbbbbbbbbb; copied data will not deduplicate',
    );
    expect(logs[0]).toMatch(/^0 info: warning: chunker parameters differ/);
    expect(fake.trace()).toContain("copy sftp:host:/r/b");
  });

  it("accepts a repo recreated with the same parameters", async () => {
    fake.writeRepo("/r/a", "pw-a", "aaaaaaaaaaaaaa");
    fake.writeRepo("sftp:host:/r/b", "pw-b", "aaaaaaaaaaaaaa");
    expect((await run([copyAB])).statuses).toEqual(["success"]);
  });

  it("warns for a copy into a repo created without them", async () => {
    // c has no `from`, so it is initialized with fresh parameters
    fake.writeRepo("/r/a", "pw-a");
    const { statuses } = await run([{ type: "copy", from: "a", to: "c" }]);
    expect(statuses).toEqual(["warning"]);
  });
});

describe("run steps", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "rescade-run-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const runStep = (command: string[] | string, extra: Record<string, unknown> = {}): Step =>
    (typeof command === "string"
      ? { type: "run", shell: true, command, env: {}, timeoutMs: 10_000, lock: [], ...extra }
      : { type: "run", shell: false, command, env: {}, timeoutMs: 10_000, lock: [], ...extra }) as Step;

  it("runs argv without a shell, with only the step's environment and cwd", async () => {
    // macOS adds __CF_USER_TEXT_ENCODING to every process
    const script =
      "console.log(process.cwd()); console.log(Object.keys(process.env).filter(k => !k.startsWith('__CF')).join(','))";
    const { logs, statuses } = await run([runStep([process.execPath, "-e", script], { env: { ONLY: "1" }, cwd: dir })]);
    expect(statuses).toEqual(["success"]);
    expect(logs).toEqual([`0 stdout: ${dir}`, "0 stdout: ONLY"]);
    expect(fake.calls()).toEqual([]);
  });

  it("does not expand shell syntax in argv", async () => {
    const { logs } = await run([runStep(["/bin/echo", "$HOME", "*", "a;b"])]);
    expect(logs).toEqual(["0 stdout: $HOME * a;b"]);
  });

  it("runs a string through /bin/sh with shell: true", async () => {
    const { logs, result } = await run([runStep("echo $GREETING | tr a-z A-Z; exit 2", { env: { GREETING: "hi" } })]);
    expect(logs).toEqual(["0 stdout: HI"]);
    expect(result.steps[0]).toMatchObject({ status: "failed", exitCode: 2, reason: "command failed (exit code 2)" });
  });

  it("fails a step that runs past its timeout", async () => {
    const { result } = await run([runStep("echo waiting for lock >&2; sleep 30", { timeoutMs: 300 }), backup]);
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(result.steps[0]?.reason).toBe("command timed out after 300ms: waiting for lock");
  });

  it("fails a step whose program does not exist", async () => {
    const { result } = await run([runStep(["/nonexistent/tool"])]);
    expect(result.steps[0]?.reason).toMatch(/^command could not be started: .*ENOENT/);
  });
});

describe("cancelling", () => {
  it("sends SIGTERM to restic, marks the step cancelled and skips the rest", async () => {
    fake.writeRepo("/r/a", "pw-a");
    const ac = new AbortController();
    const pending = run([backup, retainA], { FAKE_RESTIC_HANG: "backup" }, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.kind === "log" && e.line === "working...") ac.abort();
      },
    });
    const { result } = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.steps.map((s) => s.status)).toEqual(["cancelled", "skipped"]);
    expect(fake.sigtermReceived).toBe(true);
  });

  it("kills restic that ignores SIGTERM after the grace period", async () => {
    fake.writeRepo("/r/a", "pw-a");
    const ac = new AbortController();
    const started = Date.now();
    const { result } = await run([checkA], { FAKE_RESTIC_HANG: "check", FAKE_RESTIC_IGNORE_TERM: "1" }, {
      signal: ac.signal,
      killGraceMs: 300,
      onEvent: (e) => {
        if (e.kind === "log" && e.line === "working...") ac.abort();
      },
    });
    expect(result.steps[0]?.status).toBe("cancelled");
    expect(fake.sigtermReceived).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("starts nothing when cancelled before the run", async () => {
    const ac = new AbortController();
    ac.abort();
    const { statuses } = await run([backup, retainA], {}, { signal: ac.signal });
    expect(statuses).toEqual(["skipped", "skipped"]);
    expect(fake.calls()).toEqual([]);
  });
});

describe("repo mutexes", () => {
  const lockWith = (locks: RepoLocks, wait: boolean): RunOptions["lock"] => (repos, w) =>
    locks.acquire(repos, { runId: 1, cascade: "c" }, { wait, signal: w.signal, onWait: w.onWait });

  it("holds the repos of each step while it runs and releases them after, also on failure", async () => {
    fake.writeRepo("/r/a", "pw-a");
    const locks = new RepoLocks();
    const held: string[] = [];
    const { statuses } = await run([copyAB, checkA], { FAKE_RESTIC_EXIT_CHECK: "1" }, {
      lock: async (repos, w) => {
        const r = await lockWith(locks, false)!(repos, w);
        held.push(repos.join(","));
        return r;
      },
    });
    expect(statuses).toEqual(["success", "failed"]);
    expect(held).toEqual(["a,b", "a"]);
    expect(locks.holder("a")).toBeUndefined();
    expect(locks.holder("b")).toBeUndefined();
  });

  it("does not lock steps without repos", async () => {
    const requests: string[][] = [];
    const runNoLock: Step = { type: "run", shell: true, command: "true", env: {}, timeoutMs: 10_000, lock: [] };
    await run([runNoLock], {}, {
      lock: async (repos) => {
        requests.push(repos);
        return { ok: true, release: () => {} };
      },
    });
    expect(requests).toEqual([]);
  });

  it("skips the run from the step that finds its repo busy", async () => {
    const locks = new RepoLocks();
    await locks.acquire(["b"], { runId: 7, cascade: "maintenance" }, { wait: false });
    const { result, events } = await run([backup, copyAB, retainA], {}, { lock: lockWith(locks, false) });
    expect(result.status).toBe("skipped");
    expect(result.steps.map((s) => s.status)).toEqual(["success", "skipped", "skipped"]);
    expect(result.steps[1]?.reason).toBe('repo "b" is busy: held by run 7 (cascade "maintenance")');
    expect(result.steps[2]?.reason).toBeUndefined();
    expect(result.reason).toBe('copy a -> b: repo "b" is busy: held by run 7 (cascade "maintenance")');
    expect(events.filter((e) => e.kind === "step-start")).toHaveLength(1);
    expect(fake.calls().some((c) => c.cmd === "copy")).toBe(false);
  });

  it("waits for a busy repo and reports the wait", async () => {
    fake.writeRepo("/r/a", "pw-a");
    const locks = new RepoLocks();
    const held = await locks.acquire(["a"], { runId: 7, cascade: "other" }, { wait: false });
    setTimeout(() => held.ok && held.release(), 100);
    const { result, events } = await run([checkA], {}, { lock: lockWith(locks, true) });
    expect(result.status).toBe("success");
    expect(events.map((e) => e.kind).slice(0, 2)).toEqual(["step-wait", "step-start"]);
    expect(events[0]).toMatchObject({ reason: 'repo "a" is busy: held by run 7 (cascade "other")' });
  });

  it("is cancelled while waiting for a repo", async () => {
    const locks = new RepoLocks();
    await locks.acquire(["a"], { runId: 7, cascade: "other" }, { wait: false });
    const ac = new AbortController();
    const { result } = await run([checkA, retainA], {}, {
      signal: ac.signal,
      lock: lockWith(locks, true),
      onEvent: (e) => {
        if (e.kind === "step-wait") ac.abort();
      },
    });
    expect(result.status).toBe("cancelled");
    expect(result.steps.map((s) => s.status)).toEqual(["cancelled", "skipped"]);
    expect(fake.calls()).toEqual([]);
  });
});
