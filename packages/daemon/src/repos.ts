import type { Config, EnsureResult, LockOwner, RepoLockList, RepoLocks, RepoProblem } from "@rescade/core";

export interface RepoView {
  name: string;
  /** Repo location with any password in a URL removed. */
  location: string;
  /** Display group from the config. */
  group?: string;
  from?: string;
  /** "unknown" until the repo has been checked. */
  state: "unknown" | "ok" | RepoProblem;
  reason?: string;
  checkedAt?: number;
  id?: string;
  chunkerPolynomial?: string;
  /** restic lock files found at the last check (rescade's own restic was not running then). */
  locks?: RepoLockList;
  /** The rescade run whose step holds the repo now. */
  lockedBy?: LockOwner;
}

interface Checked {
  result: EnsureResult;
  at: number;
}

/** The last known state of each repo: from the startup pass and from the checks before every step. */
export class RepoStates {
  private readonly checked = new Map<string, Checked>();

  update(repo: string, result: EnsureResult, at: number): void {
    this.checked.set(repo, { result, at });
  }

  list(config: Config, locks: RepoLocks): RepoView[] {
    return Object.entries(config.repos).map(([name, repo]) => {
      const view: RepoView = { name, location: redact(repo.path), state: "unknown" };
      if (repo.group !== undefined) view.group = repo.group;
      if (repo.from !== undefined) view.from = repo.from;
      const c = this.checked.get(name);
      if (c) {
        view.checkedAt = c.at;
        if (c.result.ok) {
          view.state = "ok";
          view.id = c.result.config.id;
          view.chunkerPolynomial = c.result.config.chunkerPolynomial;
          view.locks = c.result.locks;
        } else {
          view.state = c.result.problem;
          view.reason = c.result.reason;
        }
      }
      const owner = locks.holder(name);
      if (owner) view.lockedBy = owner;
      return view;
    });
  }
}

/** "rest:https://user:secret@host/" -> "rest:https://user:***@host/". */
export function redact(location: string): string {
  return location.replace(/(\/\/[^/@:]+):[^/@]*@/, "$1:***@");
}
