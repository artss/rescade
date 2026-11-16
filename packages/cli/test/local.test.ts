import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_RESTIC, FakeState } from "../../core/test/helpers/fake.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const CLI = path.join(ROOT, "packages", "cli", "src", "index.ts");

let fake: FakeState;
let configFile: string;

beforeEach(async () => {
  fake = await FakeState.create();
  configFile = path.join(fake.dir, "rescade.yaml");
  await writeFile(
    configFile,
    `
repos:
  a: { path: /r/a, password: pw-a, retention: { daily: 7 } }
cascades:
  daily:
    steps:
      - retain: { repo: a }
`,
  );
});
afterEach(async () => {
  await fake.remove();
});

function runLocal(env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--conditions=source", "--import", "tsx", CLI, "run", "--local", "daily", "--config-dir", configFile, "--restic", FAKE_RESTIC],
      { cwd: ROOT, env: { ...fake.env(env), HOME: fake.dir } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("run --local", () => {
  it("runs a cascade without the daemon and says nothing about a suitable restic", async () => {
    const r = await runLocal();
    expect(r.stderr).not.toContain("warning");
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toMatch(/^cascade "daily": success in /);
  });

  it("warns about a restic older than 0.17 and still runs", async () => {
    const r = await runLocal({ FAKE_RESTIC_VERSION: "0.16.4" });
    expect(r.stderr).toMatch(/^rescade: warning: restic 0\.16\.4 \(".*fake-restic\.mjs"\) is older than 0\.17\.0: /);
    expect(r.code).toBe(0);
  });
});
