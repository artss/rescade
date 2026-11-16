import { describe, expect, it } from "vitest";
import { resticCommand, runProcess } from "../src/index.js";
import { backupArgs, failureReason, forgetArgs } from "../src/restic/restic.js";
import { repo } from "./helpers/fake.js";

describe("resticCommand", () => {
  it("passes the location and password through the environment, not the arguments", () => {
    const target = repo("/r/a", { password: "s3cret", options: { "sftp.connections": "4" } });
    const cmd = resticCommand({ PATH: "/bin", HOME: "/home/x" }, target, ["check"]);
    expect(cmd.args).toEqual(["-o", "sftp.connections=4", "check"]);
    expect(cmd.args.join(" ")).not.toContain("s3cret");
    expect(cmd.env).toMatchObject({ PATH: "/bin", HOME: "/home/x", RESTIC_REPOSITORY: "/r/a", RESTIC_PASSWORD: "s3cret" });
  });

  it("drops repository and password variables inherited from the base environment", () => {
    const cmd = resticCommand(
      {
        RESTIC_REPOSITORY: "/elsewhere",
        RESTIC_PASSWORD_FILE: "/etc/pw",
        RESTIC_FROM_PASSWORD: "x",
        RESTIC_CACHE_DIR: "/var/cache/restic",
        UNSET: undefined,
      },
      repo("/r/a"),
      ["check"],
    );
    expect(cmd.env).toEqual({
      RESTIC_CACHE_DIR: "/var/cache/restic",
      RESTIC_REPOSITORY: "/r/a",
      RESTIC_PASSWORD: "pw-a",
    });
  });

  it("adds the source repo for copy; the target's env and options win", () => {
    const from = repo("/r/a", { env: { AWS_PROFILE: "src", ONLY_SRC: "1" }, options: { "s3.region": "eu" } });
    const to = repo("/r/b", { env: { AWS_PROFILE: "dst" }, options: { "s3.region": "us" } });
    const cmd = resticCommand({}, to, ["copy"], from);
    expect(cmd.env).toEqual({
      AWS_PROFILE: "dst",
      ONLY_SRC: "1",
      RESTIC_REPOSITORY: "/r/b",
      RESTIC_PASSWORD: "pw-b",
      RESTIC_FROM_REPOSITORY: "/r/a",
      RESTIC_FROM_PASSWORD: "pw-a",
    });
    expect(cmd.args).toEqual(["-o", "s3.region=us", "copy"]);
  });
});

describe("arguments", () => {
  it("builds backup arguments from the set and the step", () => {
    const set = { include: ["/etc", "-odd"], exclude: ["**/venv", "*.bak"], tags: ["auto"], oneFileSystem: true, excludeCaches: true };
    expect(backupArgs(set, { type: "backup", set: "s", repo: "a", tags: ["auto", "daily"] })).toEqual([
      "backup", "--json", "--one-file-system", "--exclude-caches",
      "--exclude", "**/venv", "--exclude", "*.bak",
      "--tag", "auto", "--tag", "daily",
      "--", "/etc", "-odd",
    ]);
  });

  it("builds forget arguments from the retention policy, without --prune", () => {
    expect(forgetArgs({ hourly: 24, daily: 7, yearly: 0, within: "2y6m" })).toEqual([
      "forget", "--keep-hourly", "24", "--keep-daily", "7", "--keep-yearly", "0", "--keep-within", "2y6m",
    ]);
  });
});

describe("runProcess", () => {
  const node = process.execPath;

  it("reports lines from both streams, the exit code and the stderr tail", async () => {
    const lines: string[] = [];
    const r = await runProcess({
      command: node,
      args: ["-e", 'process.stdout.write("a\\nb"); console.error("oops"); process.exit(4)'],
      env: {},
      onLine: (s, l) => lines.push(`${s}:${l}`),
    });
    expect(r).toMatchObject({ code: 4, timedOut: false, cancelled: false, stderrTail: ["oops"] });
    expect(lines.sort()).toEqual(["stderr:oops", "stdout:a", "stdout:b"]);
  });

  it("keeps only what a terminal would show of lines redrawn with carriage returns", async () => {
    const lines: string[] = [];
    await runProcess({
      command: node,
      args: ["-e", 'process.stdout.write("10%\\r50%\\r100%  \\r\\n\\rdone \\n")'],
      env: {},
      onLine: (_s, l) => lines.push(l),
    });
    expect(lines).toEqual(["100%", "done"]);
  });

  it("gives the child only the environment it was given", async () => {
    const lines: string[] = [];
    await runProcess({
      command: node,
      args: ["-e", "console.log(Object.keys(process.env).filter(k => k.startsWith('X_')).join(','))"],
      env: { X_ONE: "1" },
      onLine: (_s, l) => lines.push(l),
    });
    expect(lines).toEqual(["X_ONE"]);
  });

  it("reports a program that cannot be started", async () => {
    const r = await runProcess({ command: "/nonexistent/program", args: [], env: {} });
    expect(r.code).toBeNull();
    expect(r.spawnError).toMatch(/ENOENT/);
  });

  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    // without a group kill, sleep would keep the pipes open for 30 s
    const r = await runProcess({ command: "/bin/sh", args: ["-c", "sleep 30; echo done"], env: {}, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGTERM");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("sends SIGKILL when SIGTERM is ignored", async () => {
    const r = await runProcess({
      command: node,
      args: ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
      env: {},
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(r).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("stops on abort and does not start when already aborted", async () => {
    const ac = new AbortController();
    const pending = runProcess({ command: "/bin/sh", args: ["-c", "sleep 30"], env: {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect(await pending).toMatchObject({ cancelled: true, signal: "SIGTERM" });

    const r = await runProcess({ command: "/bin/sh", args: ["-c", "exit 0"], env: {}, signal: ac.signal });
    expect(r).toMatchObject({ cancelled: true, code: null });
  });
});

describe("failureReason", () => {
  it("is the last non-empty line", () => {
    expect(failureReason(["a", "Fatal: b", ""])).toBe("Fatal: b");
    expect(failureReason(["", " "])).toBeUndefined();
  });

  it("adds the last line of ssh or rclone", () => {
    const tail = ["subprocess rclone: old", "subprocess rclone: Failed to create file system: no remote", "Fatal: EOF"];
    expect(failureReason(tail)).toBe("Fatal: EOF (rclone: Failed to create file system: no remote)");
  });

  it("hints at known_hosts when ssh rejects the host key", () => {
    const r = failureReason(["subprocess ssh: Host key verification failed.", "Fatal: unable to open repository"]);
    expect(r).toMatch(/^Fatal: unable to open repository \(ssh: Host key verification failed\.; .*~\/\.ssh\/known_hosts/);
  });

  it("does not take ssh's notice about a new host key for a reason", () => {
    const tail = ["subprocess ssh: Warning: Permanently added 'h' (ED25519) to the list of known hosts.", "Fatal: x"];
    expect(failureReason(tail)).toBe("Fatal: x");
  });

  it("passes only restic's own line through readable", () => {
    const r = failureReason(["subprocess ssh: x", '{"message":"m"}'], (l) => (JSON.parse(l) as { message: string }).message);
    expect(r).toBe("m (ssh: x)");
  });
});
