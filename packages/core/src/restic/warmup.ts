import type { Config } from "../config/types.js";
import { ensureRepo, type EnsureMemo, type EnsureResult } from "./ensure.js";
import type { ResticContext } from "./restic.js";

export interface WarmUpResult {
  results: Map<string, EnsureResult>;
  /** Repos that exist (or answered) but cannot be used: wrong password, failed init, bad output. */
  fatal: string[];
  /** `from` edges whose chunker parameters differ: copies between them will not deduplicate. */
  mismatches: string[];
}

/**
 * The startup pass over all repos: makes sure each exists (initializing missing ones, sources first)
 * and compares the chunker parameters along `from` edges. Repos are checked in parallel.
 * Unreachable repos are not fatal: they may come back later.
 */
export async function warmUp(
  config: Config,
  ctx: Omit<ResticContext, "repos">,
  log: (repo: string, line: string) => void,
): Promise<WarmUpResult> {
  const full: ResticContext = { ...ctx, repos: config.repos };
  const memo: EnsureMemo = new Map();
  const names = Object.keys(config.repos);
  const settled = await Promise.all(names.map((name) => ensureRepo(full, name, (line) => log(name, line), memo)));
  const results = new Map(names.map((name, i) => [name, settled[i]!]));

  const fatal: string[] = [];
  for (const [name, r] of results) {
    if (!r.ok && r.problem !== "unreachable" && r.problem !== "cancelled") fatal.push(`repo "${name}": ${r.reason}`);
  }
  const mismatches: string[] = [];
  for (const [name, repo] of Object.entries(config.repos)) {
    if (repo.from === undefined) continue;
    const target = results.get(name);
    const source = results.get(repo.from);
    if (target?.ok && source?.ok && target.config.chunkerPolynomial !== source.config.chunkerPolynomial) {
      mismatches.push(
        `repo "${name}" was created from "${repo.from}" but its chunker parameters differ ` +
          `(${target.config.chunkerPolynomial} vs ${source.config.chunkerPolynomial}); copied data will not deduplicate`,
      );
    }
  }
  return { results, fatal, mismatches };
}
