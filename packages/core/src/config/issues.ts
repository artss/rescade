import type { z } from "zod";

export type Path = Array<string | number>;

/** A problem found in one config entry, positioned by a path relative to that entry. */
export interface Issue {
  path: Path;
  message: string;
  /** Point at the key of the last path element instead of its value. */
  at?: "key";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** Turns zod issues into positioned issues with messages meant for people editing YAML. */
export function fromZod(error: z.ZodError, base: Path, body: unknown): Issue[] {
  const out: Issue[] = [];
  // A typo in a key also trips "needs at least one of ..." style checks on the same object;
  // the unknown key is the real problem, so drop those follow-up errors.
  const unknownKeyAt = new Set(
    error.issues.filter((i) => i.code === "unrecognized_keys").map((i) => JSON.stringify(i.path)),
  );
  for (const issue of error.issues) {
    if (issue.code === "custom" && unknownKeyAt.has(JSON.stringify(issue.path))) continue;
    const rel = issue.path.map((k) => (typeof k === "symbol" ? String(k) : k));
    const full: Path = [...base, ...rel];

    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({ path: [...full, key], message: `unknown key "${key}"`, at: "key" });
      }
      continue;
    }

    const value = getAt(body, issue.path);
    const last = rel[rel.length - 1];
    if (value === undefined && issue.code === "invalid_type" && last !== undefined) {
      out.push({ path: full, message: `missing required field "${String(last)}"` });
      continue;
    }

    let message = issue.message;
    if (issue.code === "too_small" && issue.origin === "string" && Number(issue.minimum) === 1) {
      message = "must not be empty";
    }
    if (
      issue.code === "invalid_type" &&
      issue.expected === "string" &&
      (typeof value === "number" || typeof value === "boolean")
    ) {
      message += " (quote the value to make it a string)";
    }
    out.push({ path: full, message });
  }
  return out;
}
