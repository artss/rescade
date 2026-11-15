import { Cron } from "croner";
import type { Path } from "./issues.js";
import type { Chain, Repo, Step } from "./types.js";
import type { Severity } from "./diagnostics.js";

export type Section = "repos" | "sets" | "chains";

/** A chain whose header is valid; each step is either valid or undefined (already reported). */
export interface ChainDraft {
  header: Omit<Chain, "steps">;
  steps: Array<Step | undefined>;
}

export interface SemanticInput {
  /** Every name defined in the config, even entries that failed validation. */
  declaredRepos: Set<string>;
  declaredSets: Set<string>;
  /** Only entries that passed validation. */
  repos: Map<string, Repo>;
  chains: Map<string, ChainDraft>;
}

export type Report = (
  section: Section,
  name: string,
  path: Path,
  message: string,
  severity?: Severity,
  at?: "key",
) => void;

/** Checks that need the whole config at once: references, cycles, schedules. */
export function checkSemantics(input: SemanticInput, report: Report): void {
  checkFromChains(input, report);
  for (const [name, draft] of input.chains) checkChain(name, draft, input, report);
}

/** Follows `from` links to the root repo. Returns undefined when the chain is broken or cyclic. */
function rootOf(name: string, repos: Map<string, Repo>): string | undefined {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const repo = repos.get(current);
    if (!repo) return undefined;
    if (repo.from === undefined) return current;
    current = repo.from;
  }
}

function checkFromChains({ declaredRepos, repos }: SemanticInput, report: Report): void {
  const inReportedCycle = new Set<string>();

  for (const [name, repo] of repos) {
    if (repo.from === undefined) continue;

    if (repo.from === name) {
      report("repos", name, ["from"], "a repo cannot be created from itself");
      inReportedCycle.add(name);
      continue;
    }
    if (!declaredRepos.has(repo.from)) {
      report("repos", name, ["from"], `unknown repo "${repo.from}"`);
      continue;
    }

    // walk the chain looking for a way back to a repo already visited
    const visited: string[] = [];
    let current: string | undefined = name;
    while (current !== undefined) {
      if (visited.includes(current)) {
        const cycle = visited.slice(visited.indexOf(current));
        if (!cycle.some((n) => inReportedCycle.has(n))) {
          report("repos", name, ["from"], `"from" forms a cycle: ${[...cycle, current].join(" -> ")}`);
        }
        cycle.forEach((n) => inReportedCycle.add(n));
        break;
      }
      visited.push(current);
      current = repos.get(current)?.from;
    }
  }
}

function checkChain(name: string, draft: ChainDraft, input: SemanticInput, report: Report): void {
  const { declaredRepos, declaredSets, repos } = input;
  const { header } = draft;

  if (header.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: header.timezone });
    } catch {
      report("chains", name, ["timezone"], `unknown time zone "${header.timezone}"`);
    }
  }
  header.schedule.forEach((expr, i) => {
    try {
      new Cron(expr, { paused: true });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // if `schedule` was written as a single string, the position falls back to that string
      report("chains", name, ["schedule", i], `invalid cron expression "${expr}": ${why}`);
    }
  });
  if (header.waitTimeoutMs !== undefined && header.onBusy !== "wait") {
    report("chains", name, ["wait-timeout"], 'wait-timeout only applies with on-busy: wait', "error", "key");
  }

  draft.steps.forEach((step, i) => {
    if (!step) return;
    const at = (...rest: Path): Path => ["steps", i, step.type, ...rest];

    const needRepo = (repo: string, field: string): boolean => {
      if (declaredRepos.has(repo)) return true;
      report("chains", name, at(field), `unknown repo "${repo}"`);
      return false;
    };

    switch (step.type) {
      case "backup":
        if (!declaredSets.has(step.set)) report("chains", name, at("set"), `unknown set "${step.set}"`);
        needRepo(step.repo, "repo");
        break;
      case "retain": {
        if (needRepo(step.repo, "repo")) {
          const repo = repos.get(step.repo);
          if (repo && repo.retention === undefined) {
            report(
              "chains",
              name,
              at("repo"),
              `repo "${step.repo}" has no retention policy; add "retention:" to it before using retain`,
            );
          }
        }
        break;
      }
      case "prune":
      case "check":
        needRepo(step.repo, "repo");
        break;
      case "copy": {
        const fromOk = needRepo(step.from, "from");
        const toOk = needRepo(step.to, "to");
        if (fromOk && toOk) {
          if (step.from === step.to) {
            report("chains", name, at("to"), "copy needs two different repos");
          } else {
            const a = rootOf(step.from, repos);
            const b = rootOf(step.to, repos);
            if (a !== undefined && b !== undefined && a !== b) {
              report(
                "chains",
                name,
                at(),
                `"${step.from}" and "${step.to}" are not linked by "from"; if "${step.to}" was not created with ` +
                  "--copy-chunker-params, copy will not deduplicate (rescade also checks this at run time)",
                "warning",
                "key",
              );
            }
          }
        }
        break;
      }
      case "run":
        step.lock.forEach((repo, k) => {
          if (!declaredRepos.has(repo)) report("chains", name, at("lock", k), `unknown repo "${repo}"`);
        });
        break;
    }
  });
}
