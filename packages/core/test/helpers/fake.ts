import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config, Repo } from "../../src/index.js";

export const FAKE_RESTIC = path.join(import.meta.dirname, "..", "fake-restic.mjs");
chmodSync(FAKE_RESTIC, 0o755);

export interface Call {
  cmd: string;
  args: string[];
  options: string[];
  repo?: string;
  from?: string;
  hasPassword: boolean;
  hasFromPassword: boolean;
  envKeys: string[];
}

/** A temporary state directory for the fake restic. */
export class FakeState {
  private constructor(readonly dir: string) {}

  static async create(): Promise<FakeState> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rescade-fake-"));
    await mkdir(path.join(dir, "repos"));
    return new FakeState(dir);
  }

  /** Base environment for runChain: PATH (to find node) plus the fake's switches. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_RESTIC_STATE: this.dir, ...extra };
  }

  calls(): Call[] {
    const file = path.join(this.dir, "calls.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Call);
  }

  /** Calls as "cmd repo" strings, e.g. "init /r/b", for compact assertions. */
  trace(): string[] {
    return this.calls().map((c) => `${c.cmd}${c.cmd === "cat" ? " " + c.args[0] : ""} ${c.repo}`);
  }

  private repoFile(repoPath: string): string {
    return path.join(this.dir, "repos", encodeURIComponent(repoPath) + ".json");
  }

  readRepo(repoPath: string): { id: string; chunker_polynomial: string; password: string } | undefined {
    const f = this.repoFile(repoPath);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
  }

  /** Pretends a repo already exists. */
  writeRepo(repoPath: string, password: string, polynomial = "3dbb8a5fd8c9a5"): void {
    writeFileSync(
      this.repoFile(repoPath),
      JSON.stringify({ id: "f".repeat(64), chunker_polynomial: polynomial, password }),
    );
  }

  get sigtermReceived(): boolean {
    return existsSync(path.join(this.dir, "sigterm"));
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

export function repo(p: string, extra: Partial<Repo> = {}): Repo {
  return { path: p, password: `pw-${path.basename(p)}`, env: {}, options: {}, ...extra };
}

/** a <- b (b is created from a), both with a retention policy; set "s"; chains are added per test. */
export function baseConfig(chains: Config["chains"] = {}): Config {
  return {
    repos: {
      a: repo("/r/a", { retention: { daily: 7 } }),
      b: repo("sftp:host:/r/b", { from: "a", retention: { weekly: 4, within: "1y" } }),
      c: repo("/r/c"),
    },
    sets: { s: { include: ["/etc", "/home"], exclude: ["**/venv"], tags: ["auto"], oneFileSystem: true, excludeCaches: false } },
    chains,
  };
}
