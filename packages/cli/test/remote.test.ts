import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type Daemon } from "../../daemon/src/daemon.js";
import { FAKE_RESTIC, FakeState } from "../../core/test/helpers/fake.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const CLI = path.join(ROOT, "packages", "cli", "src", "index.ts");
const TOKEN = "cli-test-token-0123456789";

let fake: FakeState;
let daemon: Daemon | undefined;

beforeEach(async () => {
  fake = await FakeState.create();
  const hold = JSON.stringify([
    process.execPath,
    "-e",
    "const f = process.argv[1]; console.log('holding'); const t = setInterval(() => require('fs').existsSync(f) && clearInterval(t), 10)",
    path.join(fake.dir, "release"),
  ]);
  const configFile = path.join(fake.dir, "rescade.yaml");
  await writeFile(
    configFile,
    `
repos:
  a: { path: /r/a, password: pw-a, retention: { daily: 7 } }
  b: { path: /r/b, password: pw-b }
cascades:
  daily:
    schedule: "0 3 * * *"
    steps:
      - retain: { repo: a }
  slow:
    steps:
      - run: { command: ${hold}, lock: [b] }
`,
  );
  daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      configDir: configFile,
      dataDir: path.join(fake.dir, "data"),
      restic: FAKE_RESTIC,
      token: TOKEN,
      extraHosts: [],
      corsOrigins: new Set(),
      logLevel: "silent",
    },
    pino({ level: "silent" }),
    { env: fake.env(), killGraceMs: 500 },
  );
});
afterEach(async () => {
  await daemon?.stop();
  await fake.remove();
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI from its sources; `onStdout` may react to output (e.g. send a signal). */
function cli(args: string[], env: Record<string, string> = {}, onStdout?: (text: string, kill: (s: NodeJS.Signals) => void) => void) {
  return new Promise<Result>((resolve) => {
    const child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", CLI, ...args], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: fake.dir,
        RESCADE_URL: `http://${daemon!.address}`,
        RESCADE_TOKEN: TOKEN,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      onStdout?.(stdout, (s) => child.kill(s));
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the CLI through the daemon", () => {
  it("runs a cascade and follows it to the end", async () => {
    const r = await cli(["run", "daily"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^run \d+ of "daily" started$/);
    expect(lines).toContain("==> [1/1] retain a");
    expect(lines).toContain("    Applying Policy: keep 7 daily snapshots");
    expect(lines.some((l) => /^<== \[1\/1\] success in \d+/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^cascade "daily": success in /);
  });

  it("shows status, runs, a run and its log", async () => {
    const run = await cli(["run", "daily", "--detach", "--json"]);
    const id = JSON.parse(run.stdout).id as number;
    for (let i = 0; i < 100; i++) {
      const runs = JSON.parse((await cli(["runs", "--json", "--cascade", "daily"])).stdout) as Array<{ status: string }>;
      if (runs[0]?.status === "success") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const status = await cli(["status"]);
    expect(status.stdout).toMatch(/^rescaded \d+\.\d+\.\d+, up since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\nconfig .+, loaded /);
    expect(status.stdout).not.toContain("failed");
    expect(status.stdout).toMatch(new RegExp(`^daily +success .* \\(run ${id}\\) +\\d{4}-\\d\\d-\\d\\d 03:00:00 +-$`, "m"));
    expect(status.stdout).toMatch(/^slow +- +manual +-$/m);

    const show = await cli(["show", String(id)]);
    expect(show.stdout).toMatch(new RegExp(`^run ${id} of "daily" \\(manual\\), started .*: success in `));
    expect(show.stdout).toMatch(/<== \[1\] success in /);

    const log = await cli(["log", String(id), "--step", "1"]);
    expect(log.stdout).toContain("    Applying Policy: keep 7 daily snapshots");
  });

  it("tells when a config reload failed", async () => {
    await writeFile(path.join(fake.dir, "rescade.yaml"), "cascades: [");
    expect(await daemon!.reload()).toBe(false);
    const status = await cli(["status"]);
    expect(status.stdout).toMatch(/^reload at .* failed, the config loaded before stays in use:\n  .*rescade\.yaml:1:\d+: error: /m);
    expect(status.stdout).toMatch(/^daily /m);
  });

  it("reports a busy cascade as skipped and cancels a run", async () => {
    const first = await cli(["run", "slow", "--detach"]);
    expect(first.stdout).toMatch(/^run \d+ started\n$/);
    const id = Number(/run (\d+)/.exec(first.stdout)![1]);

    const second = await cli(["run", "slow"]);
    expect(second.code).toBe(75);
    expect(second.stderr).toMatch(new RegExp(`skipped: run ${id} of this cascade is still in progress`));

    const repos = await cli(["repos"]);
    expect(repos.stdout).toMatch(new RegExp(`^b +ok +\\S+ \\S+ +run ${id} \\(slow\\) +0 +/r/b$`, "m"));

    expect((await cli(["cancel", String(id)])).stdout).toBe(`cancelling run ${id}\n`);
    const again = await cli(["cancel", "999"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toBe("rescade: no run 999\n");
  });

  it("shows restic locks found before a step", async () => {
    const id = "ab".repeat(32);
    const time = new Date(Date.now() - 2 * 3_600_000).toISOString();
    fake.writeLocks("/r/a", [{ id, time, exclusive: true, hostname: "nas", username: "root", pid: 42 }]);
    expect((await cli(["run", "daily"])).code).toBe(0);

    const repos = await cli(["repos"]);
    expect(repos.stdout).toMatch(/^a +ok +\S+ \S+ +- +1 \(1 stale\) +\/r\/a$/m);
    expect(repos.stdout).toMatch(/^a: lock abababab \(exclusive, stale\) by root@nas pid 42 at \S+ \S+$/m);
    expect(repos.stdout).toContain('run "restic unlock"');
  });

  it("lists snapshots and browses one", async () => {
    const id = "c".repeat(64);
    fake.writeSnapshots(
      "/r/a",
      [
        {
          time: "2026-11-01T10:00:00Z",
          paths: ["/home"],
          hostname: "nas",
          username: "root",
          tags: ["auto", "daily"],
          summary: { total_bytes_processed: 3 * 1024 * 1024 },
          id,
          short_id: id.slice(0, 8),
        },
      ],
      {
        [id]: [
          { name: "home", type: "dir", path: "/home", permissions: "drwxr-xr-x" },
          { name: "z.txt", type: "file", path: "/home/z.txt", size: 10, permissions: "-rw-r--r--", mtime: "2026-11-01T10:00:00Z" },
          { name: "u", type: "dir", path: "/home/u", permissions: "drwx------", mtime: "2026-11-01T10:00:00Z" },
        ],
      },
    );
    const list = await cli(["snapshots", "a"]);
    expect(list.stdout).toMatch(/^ID +TIME +HOST +SIZE +TAGS +PATHS\ncccccccc +\S+ \S+ +nas +3\.0 MiB +auto,daily +\/home\n$/);
    expect((await cli(["snapshots", "b"])).stdout).toBe('no snapshots in "b"\n');

    const ls = await cli(["ls", "a", "cccccccc", "/home"]);
    expect(ls.stdout).toMatch(/^drwx------ +\S+ \S+ +u\/\n-rw-r--r-- +10 B +\S+ \S+ +z\.txt\n$/);
    expect((await cli(["ls", "a", id])).stdout).toMatch(/^drwxr-xr-x +home\/\n$/);

    const missing = await cli(["ls", "a", id, "/nope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe("rescade: no /nope in snapshot cccccccc\n");
    expect((await cli(["ls", "a"])).stderr).toBe("rescade: ls needs a repo, a snapshot id and optionally a path\n");
  });

  it("cancels the followed run on Ctrl+C", async () => {
    let sent = false;
    const r = await cli(["run", "slow"], {}, (text, kill) => {
      if (!sent && text.includes("==> [1/1]")) {
        sent = true;
        kill("SIGINT");
      }
    });
    expect(r.stderr).toMatch(/cancelling run \d+/);
    expect(r.stdout).toMatch(/cascade "slow": cancelled/);
    expect(r.code).toBe(130);
  });

  it("explains connection and token problems", async () => {
    const wrong = await cli(["status"], { RESCADE_TOKEN: "wrong" });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toBe("rescade: the daemon rejected the API token (missing or wrong API token)\n");

    const noToken = await cli(["status"], { RESCADE_TOKEN: "" });
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain(`no API token: ENOENT`);

    // a port nobody listens on
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise((resolve) => server.close(resolve));
    const down = await cli(["status", "--url", `http://127.0.0.1:${port}`]);
    expect(down.code).toBe(1);
    expect(down.stderr).toBe(`rescade: cannot reach the daemon at http://127.0.0.1:${port} (ECONNREFUSED)\n`);

    const usage = await cli(["show"]);
    expect(usage.code).toBe(2);
    expect((await cli(["runs", "--step", "1"])).stderr).toBe("rescade: runs does not take --step\n");
  });
});
