import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedHosts, parseAddr, readSettings, SettingsError } from "../src/settings.js";

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
      extraHosts: [],
    });
    expect(s !== "help" && [...s.corsOrigins]).toEqual(["https://a", "https://b"]);
    expect(warnings).toEqual([]);
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

  it("accepts loopback names, the listen address and extra hosts", () => {
    expect([...allowedHosts("0.0.0.0", 8765, ["backup.lan", "Proxy.Lan:443", "fe80::1"])]).toEqual([
      "localhost:8765",
      "127.0.0.1:8765",
      "[::1]:8765",
      "0.0.0.0:8765",
      "backup.lan:8765",
      "proxy.lan:443",
      "[fe80::1]:8765",
    ]);
    expect(allowedHosts("::1", 1, []).has("[::1]:1")).toBe(true);
  });
});
