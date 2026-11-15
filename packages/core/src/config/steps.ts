import { z } from "zod";
import { duration, envMap, parseDuration, ref } from "./schema.js";
import { fromZod, isPlainObject, type Issue, type Path } from "./issues.js";
import { DEFAULT_RUN_TIMEOUT_MS, type Step } from "./types.js";

export const ACTIONS = ["backup", "retain", "prune", "check", "copy", "run"] as const;
export type Action = (typeof ACTIONS)[number];

function isAction(key: string): key is Action {
  return (ACTIONS as readonly string[]).includes(key);
}

const stringList = z.array(z.string().min(1));

const BackupBody = z.strictObject({ set: ref, repo: ref, tags: stringList.optional() });
const RetainBody = z.strictObject({ repo: ref });
const PruneBody = z.strictObject({ repo: ref, "max-unused": z.string().min(1).optional() });
const CheckBody = z.strictObject({ repo: ref, "read-data-subset": z.string().min(1).optional() });
const CopyBody = z.strictObject({ from: ref, to: ref });
const RunBody = z.strictObject({
  // checked by hand in checkCommand() for clearer messages
  command: z.unknown(),
  shell: z.boolean().optional(),
  env: envMap.optional(),
  cwd: z.string().min(1).optional(),
  timeout: duration.optional(),
  lock: z.array(ref).optional(),
});

/** `command` is a list of strings, or a single string when the step runs through a shell. */
function checkCommand(value: unknown, shell: boolean, path: Path): { command?: string[] | string; issues: Issue[] } {
  const bad = (message: string, at: Path = path): { issues: Issue[] } => ({ issues: [{ path: at, message }] });

  if (value === undefined) return bad('missing required field "command"', path.slice(0, -1));

  if (typeof value === "string") {
    if (value.trim() === "") return bad("must not be empty");
    return shell
      ? { command: value, issues: [] }
      : bad("command must be a list of arguments; use shell: true to run a shell string");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return bad("command must not be empty");
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (typeof item !== "string") {
        const hint = typeof item === "boolean" || typeof item === "number" ? ` (quote it: "${String(item)}")` : "";
        return bad(`command arguments must be strings${hint}`, [...path, i]);
      }
    }
    if (value[0] === "") return bad("the program to run must not be empty", [...path, 0]);
    return shell
      ? bad("with shell: true, command must be a single string")
      : { command: value as string[], issues: [] };
  }
  return bad("command must be a list of arguments (or a string when shell: true)");
}

export interface StepResult {
  step?: Step;
  issues: Issue[];
}

/**
 * Validates one entry of `steps:`. A step is a mapping with exactly one action key
 * (backup, retain, prune, check, copy, run) and an optional `name`.
 * `base` is the path of the step relative to its cascade entry.
 */
export function validateStep(raw: unknown, base: Path): StepResult {
  if (!isPlainObject(raw)) {
    return {
      issues: [
        {
          path: base,
          message: 'a step must be a mapping with one action, e.g. "- backup: { set: home, repo: home-local }"',
        },
      ],
    };
  }

  const issues: Issue[] = [];
  const keys = Object.keys(raw);
  const actions = keys.filter(isAction);

  for (const key of keys) {
    if (isAction(key) || key === "name") continue;
    issues.push({
      path: [...base, key],
      message:
        actions.length > 0
          ? `unknown key "${key}" in step`
          : `unknown step action "${key}" (expected one of: ${ACTIONS.join(", ")})`,
      at: "key",
    });
  }
  if (actions.length === 0 && issues.length === 0) {
    issues.push({ path: base, message: `step has no action (expected one of: ${ACTIONS.join(", ")})` });
  }
  if (actions.length > 1) {
    issues.push({
      path: [...base, actions[1]!],
      message: `a step can have only one action, found: ${actions.join(", ")}`,
      at: "key",
    });
  }
  if ("name" in raw && typeof raw.name !== "string") {
    issues.push({ path: [...base, "name"], message: "name must be a string" });
  }
  if (issues.length > 0 || actions.length !== 1) return { issues };

  const action = actions[0]!;
  const body = raw[action];
  const bodyPath: Path = [...base, action];
  const name = typeof raw.name === "string" ? raw.name : undefined;

  switch (action) {
    case "backup": {
      const r = BackupBody.safeParse(body);
      if (!r.success) return { issues: fromZod(r.error, bodyPath, body) };
      return {
        step: { type: "backup", name, set: r.data.set, repo: r.data.repo, tags: r.data.tags ?? [] },
        issues: [],
      };
    }
    case "retain": {
      const r = RetainBody.safeParse(body);
      if (!r.success) return { issues: fromZod(r.error, bodyPath, body) };
      return { step: { type: "retain", name, repo: r.data.repo }, issues: [] };
    }
    case "prune": {
      const r = PruneBody.safeParse(body);
      if (!r.success) return { issues: fromZod(r.error, bodyPath, body) };
      return {
        step: { type: "prune", name, repo: r.data.repo, maxUnused: r.data["max-unused"] },
        issues: [],
      };
    }
    case "check": {
      const r = CheckBody.safeParse(body);
      if (!r.success) return { issues: fromZod(r.error, bodyPath, body) };
      return {
        step: { type: "check", name, repo: r.data.repo, readDataSubset: r.data["read-data-subset"] },
        issues: [],
      };
    }
    case "copy": {
      const r = CopyBody.safeParse(body);
      if (!r.success) return { issues: fromZod(r.error, bodyPath, body) };
      return { step: { type: "copy", name, from: r.data.from, to: r.data.to }, issues: [] };
    }
    case "run": {
      const r = RunBody.safeParse(body);
      const found: Issue[] = r.success ? [] : fromZod(r.error, bodyPath, body);
      const shell = r.success ? (r.data.shell ?? false) : isPlainObject(body) && body.shell === true;
      // `command` is z.unknown(), so zod never reports it; check it here, alongside the other fields
      const cmd = checkCommand(isPlainObject(body) ? body.command : undefined, shell, [...bodyPath, "command"]);
      found.push(...cmd.issues);
      if (!r.success || found.length > 0 || cmd.command === undefined) return { issues: found };

      const d = r.data;
      const common = {
        type: "run" as const,
        name,
        env: d.env ?? {},
        cwd: d.cwd,
        timeoutMs: d.timeout === undefined ? DEFAULT_RUN_TIMEOUT_MS : parseDuration(d.timeout),
        lock: d.lock ?? [],
      };
      return shell
        ? { step: { ...common, shell: true as const, command: cmd.command as string }, issues: [] }
        : { step: { ...common, shell: false as const, command: cmd.command as string[] }, issues: [] };
    }
  }
}
