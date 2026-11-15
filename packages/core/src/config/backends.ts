import { OWN_VARS } from "../restic/restic.js";
import type { Severity } from "./diagnostics.js";
import type { Issue } from "./issues.js";
import type { Repo } from "./types.js";

/** Backends restic picks by the location prefix; anything without a known prefix is a local path. */
export const BACKENDS = ["local", "sftp", "rest", "s3", "swift", "b2", "azure", "gs", "rclone"] as const;
export type Backend = (typeof BACKENDS)[number];

/** Extended options (`-o key=value`) per backend, as `restic options` lists them (0.19). */
const OPTIONS: Record<Backend, string[]> = {
  local: ["connections"],
  sftp: ["args", "command", "connections"],
  rest: ["connections"],
  s3: [
    "bucket-lookup",
    "connections",
    "enable-restore",
    "layout",
    "list-objects-v1",
    "region",
    "restore-days",
    "restore-tier",
    "restore-timeout",
    "retries",
    "storage-class",
    "unsafe-anonymous-auth",
  ],
  swift: ["connections"],
  b2: ["connections"],
  azure: ["access-tier", "connections"],
  gs: ["connections", "region"],
  rclone: ["args", "connections", "program", "timeout"],
};

const isBackend = (s: string): s is Backend => (BACKENDS as readonly string[]).includes(s);

export function backendOf(location: string): Backend {
  const m = /^([a-z0-9]+):/.exec(location);
  return m && isBackend(m[1]!) ? m[1]! : "local";
}

export type RepoIssue = Issue & { severity: Severity };

/** Checks of one repo that restic itself would only catch at run time, or not at all. */
export function checkRepo(repo: Repo): RepoIssue[] {
  const out: RepoIssue[] = [];
  const backend = backendOf(repo.path);

  // restic rejects these too, but only when a step runs
  const scheme = /^([A-Za-z0-9][A-Za-z0-9.+-]+):/.exec(repo.path)?.[1];
  if (scheme !== undefined && !isBackend(scheme)) {
    out.push({
      path: ["path"],
      severity: "error",
      message:
        `"${scheme}:" is not a restic backend (${BACKENDS.join(", ")}). Write "sftp:${repo.path}" for SFTP, ` +
        `or "local:${repo.path}" for a local directory with ":" in its name`,
    });
  }

  for (const key of Object.keys(repo.env)) {
    if (OWN_VARS.has(key)) {
      out.push({
        path: ["env", key],
        at: "key",
        severity: "error",
        message: `${key} is set by rescade from "path" and "password"; remove it from env`,
      });
    }
  }

  for (const key of Object.keys(repo.options)) {
    const [ns, name] = splitOption(key);
    const at = { path: ["options", key], at: "key" as const };
    if (name === undefined || !isBackend(ns)) {
      out.push({ ...at, severity: "error", message: `unknown option "${key}": options look like "<backend>.<name>"` });
    } else if (ns !== backend) {
      out.push({
        ...at,
        severity: "error",
        message: `option "${key}" is for the ${ns} backend, but this repo uses ${backend}; restic would ignore it`,
      });
    } else if (!OPTIONS[ns].includes(name)) {
      out.push({
        ...at,
        severity: "warning",
        message:
          `option "${key}" is unknown to rescade (known ${ns} options: ${OPTIONS[ns].join(", ")}); ` +
          "restic fails on options it does not know",
      });
    }
  }
  return out;
}

function splitOption(key: string): [string, string | undefined] {
  const dot = key.indexOf(".");
  return dot <= 0 || dot === key.length - 1 ? [key, undefined] : [key.slice(0, dot), key.slice(dot + 1)];
}

/**
 * One restic process serves both repos of `copy` and `init --from-repo`, and only the repository and the
 * password have separate variables for the source. Backend credentials and `-o` options apply to both.
 * Reports settings that would leak from one repo to the other.
 */
export function sharedSettingsIssues(
  fromName: string,
  from: Repo,
  toName: string,
  to: Repo,
): Array<{ message: string; severity: Severity }> {
  const sameBackend = backendOf(from.path) === backendOf(to.path);
  const out: Array<{ message: string; severity: Severity }> = [];
  const hint =
    "restic runs once for both repos; put REST credentials into the URL, SFTP keys into ~/.ssh/config, " +
    "or use the rclone backend with a remote per account";

  const compare = (kind: "env" | "option", a: Record<string, string>, b: Record<string, string>) => {
    const differ: string[] = [];
    const leak: string[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] !== undefined && b[key] !== undefined) {
        if (a[key] !== b[key]) differ.push(key);
      } else {
        leak.push(key);
      }
    }
    // options are namespaced by backend, so they only meet when both repos use the same one
    if (differ.length > 0 && (kind === "env" || sameBackend)) {
      out.push({
        severity: sameBackend ? "error" : "warning",
        message:
          `${kind} ${differ.join(", ")} differ between "${fromName}" and "${toName}", but restic would use ` +
          `the values of "${toName}" for both; ${hint}`,
      });
    }
    if (leak.length > 0 && sameBackend) {
      out.push({
        severity: "warning",
        message:
          `${kind} ${leak.join(", ")} set on only one of "${fromName}" and "${toName}" also applies ` +
          `to the other; ${hint}`,
      });
    }
  };
  compare("env", from.env, to.env);
  compare("option", from.options, to.options);
  return out;
}
