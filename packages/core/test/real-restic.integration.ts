import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkResticVersion, ensureRepo, runCascade, type Cascade, type Config, type RunEvent, type Step } from "../src/index.js";
import { repo } from "./helpers/fake.js";

const RESTIC = process.env.RESCADE_RESTIC ?? "restic";
const isRoot = process.getuid?.() === 0;

let dir: string;
let src: string;
let env: Record<string, string>;

beforeAll(async () => {
  // fail early and clearly when restic is missing or too old
  const version = await checkResticVersion(RESTIC, process.env);
  if (version.warning !== undefined) throw new Error(version.warning);
  dir = await mkdtemp(path.join(os.tmpdir(), "rescade-real-"));
  src = path.join(dir, "src");
  await mkdir(path.join(src, "sub"), { recursive: true });
  await writeFile(path.join(src, "a.txt"), "hello\n");
  await writeFile(path.join(src, "sub", "b.txt"), "world\n");
  await writeFile(path.join(src, "skip.bak"), "excluded\n");
  env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, RESTIC_CACHE_DIR: path.join(dir, "cache") };
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }); // unset when beforeAll stopped early
});

function config(steps: Step[], overrides: Partial<Config["repos"]> = {}): Config {
  const cascade: Cascade = { schedule: [], onBusy: "skip", steps };
  return {
    repos: {
      a: repo(path.join(dir, "a"), { retention: { last: 1 } }),
      b: repo(path.join(dir, "b"), { from: "a", retention: { last: 1 } }),
      c: repo(path.join(dir, "c")),
      ...overrides,
    } as Config["repos"],
    sets: { s: { include: [src], exclude: ["*.bak"], tags: ["it"], oneFileSystem: false, excludeCaches: true } },
    cascades: { c: cascade },
  };
}

async function run(steps: Step[], overrides: Partial<Config["repos"]> = {}) {
  const logs: string[] = [];
  const result = await runCascade(config(steps, overrides), "c", {
    restic: RESTIC,
    env,
    onEvent: (e: RunEvent) => {
      if (e.kind === "log") logs.push(`${e.index} ${e.stream}: ${e.line}`);
    },
  });
  return { result, logs, statuses: result.steps.map((s) => s.status) };
}

function snapshots(name: "a" | "b" | "c"): Array<{ paths: string[]; tags?: string[] }> {
  const out = execFileSync(RESTIC, ["snapshots", "--json"], {
    env: { ...env, RESTIC_REPOSITORY: path.join(dir, name), RESTIC_PASSWORD: `pw-${name}` },
  });
  return JSON.parse(out.toString());
}

function polynomial(name: "a" | "b" | "c"): string {
  const out = execFileSync(RESTIC, ["cat", "config"], {
    env: { ...env, RESTIC_REPOSITORY: path.join(dir, name), RESTIC_PASSWORD: `pw-${name}` },
  });
  return (JSON.parse(out.toString()) as { chunker_polynomial: string }).chunker_polynomial;
}

describe("with real restic", () => {
  it("initializes repos, backs up, forgets, checks, copies and prunes", async () => {
    const backup: Step = { type: "backup", set: "s", repo: "a", tags: ["manual"] };
    const { result, logs } = await run([
      backup,
      backup,
      { type: "retain", repo: "a" },
      { type: "check", repo: "a", readDataSubset: "10%" },
      { type: "copy", from: "a", to: "b" },
      { type: "prune", repo: "a", maxUnused: "0%" },
    ]);

    expect(result.steps.map((s) => [s.label, s.status, s.reason])).toEqual([
      ["backup s -> a", "success", undefined],
      ["backup s -> a", "success", undefined],
      ["retain a", "success", undefined],
      ["check a", "success", undefined],
      ["copy a -> b", "success", undefined],
      ["prune a", "success", undefined],
    ]);
    expect(logs).toContain('0 info: repo "a" does not exist, initializing it');
    expect(logs).toContain('4 info: repo "b" does not exist, initializing it with the chunker parameters of "a"');
    expect(result.steps[0]?.summary).toMatchObject({ message_type: "summary", files_new: 2 });
    expect(result.steps[1]?.summary).toMatchObject({ files_new: 0, files_unmodified: 2 });

    const snaps = snapshots("a");
    expect(snaps).toHaveLength(1); // retention: last 1
    expect(snaps[0]?.tags?.sort()).toEqual(["it", "manual"]);
    expect(snapshots("b")).toHaveLength(1);
    expect(polynomial("b")).toBe(polynomial("a"));
  });

  it.skipIf(isRoot)("reports unreadable files as a warning and goes on", async () => {
    const locked = path.join(src, "locked.txt");
    await writeFile(locked, "secret\n");
    await chmod(locked, 0o000);
    try {
      const { result, logs } = await run([
        { type: "backup", set: "s", repo: "a", tags: [] },
        { type: "check", repo: "a" },
      ]);
      expect(result.steps.map((s) => s.status)).toEqual(["warning", "success"]);
      expect(result.steps[0]).toMatchObject({ exitCode: 3, summary: expect.objectContaining({ message_type: "summary" }) });
      expect(logs.some((l) => /^0 stderr: error: .*locked\.txt: .*permission denied$/.test(l))).toBe(true);
      expect(logs).toContain("0 stderr: Warning: at least one source file could not be read");
    } finally {
      await rm(locked, { force: true });
    }
  });

  it("gives up on a REST server that does not answer instead of waiting for restic's retries", async () => {
    const cfg = config([{ type: "check", repo: "a" }], { a: repo("rest:http://127.0.0.1:1/") });
    const started = Date.now();
    const result = await runCascade(cfg, "c", { restic: RESTIC, env, repoCheckTimeoutMs: 3000 });
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.reason).toMatch(/^repo "a" did not respond within 3s: .*connection refused/);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("fails on a wrong password and does not touch the repo", async () => {
    const { result } = await run([{ type: "check", repo: "a" }], { a: repo(path.join(dir, "a"), { password: "wrong" }) });
    expect(result.steps[0]).toMatchObject({ status: "failed", reason: 'wrong password for repo "a"' });
  });

  it("warns before copying into a repo with other chunker parameters", async () => {
    const { result } = await run([{ type: "copy", from: "a", to: "c" }]);
    expect(result.steps[0]?.status).toBe("warning");
    expect(result.steps[0]?.reason).toMatch(/^chunker parameters differ: "a" has \w+, "c" has \w+/);
    expect(snapshots("c").length).toBeGreaterThan(0);
  });

  it("finds the lock left by a killed restic", async () => {
    const repos = config([]).repos;
    const a = repos.a!;
    const child = spawn(RESTIC, ["backup", "-q", "--stdin-from-command", "--", "sleep", "30"], {
      env: { ...env, RESTIC_REPOSITORY: a.path, RESTIC_PASSWORD: a.password },
      stdio: "ignore",
    });
    const locksDir = path.join(a.path, "locks");
    const deadline = Date.now() + 10_000;
    while ((await readdir(locksDir)).length === 0) {
      if (Date.now() > deadline) throw new Error("restic did not take a lock");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));

    const r = await ensureRepo({ binary: RESTIC, env, repos }, "a", () => {});
    expect(r).toMatchObject({ ok: true, locks: { count: 1, locks: [{ exclusive: false, pid: child.pid, stale: false }] } });
    execFileSync(RESTIC, ["unlock", "--remove-all"], { env: { ...env, RESTIC_REPOSITORY: a.path, RESTIC_PASSWORD: a.password } });
  });

  it("reports a failing backup with restic's own message, not JSON", async () => {
    const cfg = config([{ type: "backup", set: "gone", repo: "a", tags: [] }]);
    cfg.sets.gone = { include: [path.join(dir, "does-not-exist")], exclude: [], tags: [], oneFileSystem: false, excludeCaches: false };
    const result = await runCascade(cfg, "c", { restic: RESTIC, env });
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.reason).toMatch(/^restic backup failed \(exit code 1\): Fatal: /);
    expect(result.steps[0]?.reason).not.toContain("{");
  });
});
