import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedHosts, hostAllowed, parseAddr, readSettings, SettingsError } from "../src/settings.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rescade-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tokenFile(name: string, text: string, mode = 0o600): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, text);
  await chmod(file, mode);
  return file;
}

describe("daemon settings", () => {
  it("takes flags over the environment and has defaults", async () => {
    const warnings: string[] = [];
    const s = await readSettings(
      ["--addr", "[::1]:9000", "--data-dir", "/d"],
      { RESCADE_ADDR: "0.0.0.0:1", RESCADE_TOKEN: "t", RESCADE_REPO_CHECK_TIMEOUT: "30s", RESCADE_CORS_ORIGINS: "https://a, https://b" },
      (m) => warnings.push(m),
    );
    expect(s).toMatchObject({
      host: "::1",
      port: 9000,
      dataDir: "/d",
      configDir: "config",
      restic: "restic",
      token: "t",
      repoCheckTimeoutMs: 30_000,
      historyRetentionMs: 180 * 86_400_000,
      logRetentionMs: 30 * 86_400_000,
      logLevel: "info",
      extraHosts: undefined,
    });
    expect(s !== "help" && [...s.corsOrigins]).toEqual(["https://a", "https://b"]);
    expect(warnings).toEqual([]);
  });

  it("takes a restore directory as an absolute path, creating it when missing", async () => {
    const env = { RESCADE_TOKEN: "t" };
    expect(await readSettings([], env, () => {})).not.toHaveProperty("restoreDir");
    expect(await readSettings([], { ...env, RESCADE_RESTORE_DIR: dir }, () => {})).toMatchObject({ restoreDir: dir });
    const rel = path.relative(process.cwd(), dir);
    expect(await readSettings(["--restore-dir", rel], { ...env, RESCADE_RESTORE_DIR: "/nope" }, () => {})).toMatchObject({
      restoreDir: dir,
    });
    const created = path.join(dir, "new", "restore");
    expect(await readSettings(["--restore-dir", created], env, () => {})).toMatchObject({ restoreDir: created });
    expect((await stat(created)).isDirectory()).toBe(true);
    expect((await stat(created)).mode & 0o777).toBe(0o700);

    const file = await tokenFile("file", "x");
    await expect(readSettings([], { ...env, RESCADE_RESTORE_DIR: file }, () => {})).rejects.toThrow(
      `restore directory ${file} is not a directory`,
    );
    // a file on the way: the directory cannot be created
    await expect(readSettings([], { ...env, RESCADE_RESTORE_DIR: path.join(file, "sub") }, () => {})).rejects.toThrow(
      `cannot create restore directory ${path.join(file, "sub")} (ENOTDIR)`,
    );
  });

  it("reads the retention periods, 0 meaning no limit", async () => {
    const s = await readSettings([], { RESCADE_TOKEN: "t", RESCADE_HISTORY_RETENTION: "0", RESCADE_LOG_RETENTION: "12h" }, () => {});
    expect(s).toMatchObject({ historyRetentionMs: undefined, logRetentionMs: 12 * 3_600_000 });
    await expect(readSettings([], { RESCADE_TOKEN: "t", RESCADE_LOG_RETENTION: "month" }, () => {})).rejects.toThrow(
      'RESCADE_LOG_RETENTION: expected a duration such as "30s", "5m" or "90d", got "month"',
    );
  });

  it("reads the token from a file and warns when others can read it", async () => {
    const file = await tokenFile("token", "secret\n", 0o644);
    const warnings: string[] = [];
    const s = await readSettings(["--token-file", file], { RESCADE_TOKEN: "ignored" }, (m) => warnings.push(m));
    expect(s !== "help" && s.token).toBe("secret");
    expect(warnings).toEqual([`${file}: the token file has mode 644, others can read it (chmod 600 ${file})`]);
  });

  it("refuses to run without a token", async () => {
    const missing = path.join(dir, "none");
    const err = await readSettings([], { RESCADE_TOKEN_FILE: missing }, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as Error).message).toMatch(/^no API token: .*ENOENT/);
    expect((err as Error).message).toContain(`openssl rand -hex 32 > ${missing}`);
    const empty = await tokenFile("empty", "\n");
    await expect(readSettings([], { RESCADE_TOKEN_FILE: empty }, () => {})).rejects.toThrow("the token file is empty");
  });

  it("rejects bad values", async () => {
    const env = { RESCADE_TOKEN: "t" };
    await expect(readSettings(["--addr", "8765"], env, () => {})).rejects.toThrow('got "8765"');
    await expect(readSettings(["--log-level", "loud"], env, () => {})).rejects.toThrow('unknown log level "loud"');
    await expect(readSettings([], { ...env, RESCADE_REPO_CHECK_TIMEOUT: "soon" }, () => {})).rejects.toThrow("RESCADE_REPO_CHECK_TIMEOUT");
    await expect(readSettings(["--bogus"], env, () => {})).rejects.toThrow(SettingsError);
  });

  it("parses addresses", () => {
    expect(parseAddr("localhost:8765")).toEqual({ host: "localhost", port: 8765 });
    expect(parseAddr("[fe80::1]:80")).toEqual({ host: "fe80::1", port: 80 });
    expect(() => parseAddr("::1:80")).toThrow(SettingsError);
  });

  it("reads the allowed hosts, unset or empty meaning any", async () => {
    const hosts = async (value?: string) => {
      const env: Record<string, string> = { RESCADE_TOKEN: "t" };
      if (value !== undefined) env.RESCADE_ALLOWED_HOSTS = value;
      const s = await readSettings([], env, () => {});
      return s !== "help" && s.extraHosts;
    };
    expect(await hosts()).toBeUndefined();
    expect(await hosts("")).toBeUndefined();
    expect(await hosts(" , ")).toBeUndefined();
    expect(await hosts("a.lan, b.lan:443")).toEqual(["a.lan", "b.lan:443"]);
  });

  it("accepts loopback names, the listen address and extra hosts", () => {
    expect([...allowedHosts("0.0.0.0", 8765, ["backup.lan", "Proxy.Lan:443", "fe80::1", "[fe80::2]:80"])]).toEqual([
      "localhost:8765",
      "127.0.0.1:8765",
      "[::1]:8765",
      "0.0.0.0:8765",
      "backup.lan",
      "proxy.lan:443",
      "[fe80::1]",
      "[fe80::2]:80",
    ]);
    expect(allowedHosts("::1", 1, []).has("[::1]:1")).toBe(true);
  });

  it("matches a Host header on the given port, or on any port for a bare name", () => {
    const allowed = allowedHosts("127.0.0.1", 8765, ["backup.lan", "proxy.lan:443", "fe80::1"]);
    const ok = (h: string) => hostAllowed(allowed, h);
    expect(ok("127.0.0.1:8765")).toBe(true);
    expect(ok("127.0.0.1:80")).toBe(false);
    expect(ok("127.0.0.1")).toBe(false);
    expect(ok("Backup.LAN")).toBe(true);
    expect(ok("backup.lan:8765")).toBe(true);
    expect(ok("backup.lan:443")).toBe(true);
    expect(ok("proxy.lan:443")).toBe(true);
    expect(ok("proxy.lan:8765")).toBe(false);
    expect(ok("proxy.lan")).toBe(false);
    expect(ok("[fe80::1]")).toBe(true);
    expect(ok("[fe80::1]:9")).toBe(true);
    expect(ok("evil.example")).toBe(false);
    expect(ok("")).toBe(false);
  });

});
