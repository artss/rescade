import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LineCounter, parseDocument, visit, isMap, isScalar, type Document } from "yaml";
import { displayPath, type Diagnostic, type Severity } from "./diagnostics.js";
import { expandString } from "./expand.js";
import { fromZod, isPlainObject, type Issue, type Path } from "./issues.js";
import { locate, positionAt, type Source } from "./locate.js";
import {
  ChainSchema,
  RepoSchema,
  SetSchema,
  normalizeChainHeader,
  normalizeRepo,
  normalizeSet,
} from "./schema.js";
import { checkSemantics, type ChainDraft, type Section } from "./semantic.js";
import { validateStep } from "./steps.js";
import type { BackupSet, Chain, Config, Repo } from "./types.js";

export interface LoadOptions {
  /** A directory of *.yaml / *.yml files, or a single YAML file. */
  path: string;
  /** Environment used for ${VAR} expansion. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** What to do about unset variables: fail (default) or warn (for validate-only runs). */
  missingEnv?: "error" | "warn";
}

export interface Origin {
  file: string;
  line: number;
  col: number;
}

export interface LoadResult {
  /** True when there are no errors (warnings are allowed). */
  ok: boolean;
  /** Present only when ok. */
  config?: Config;
  diagnostics: Diagnostic[];
  /** Config files that were read, in merge order. */
  files: string[];
  /** Every environment variable the config refers to. */
  referencedEnv: string[];
  /**
   * Variables that were referenced but not set. Only non-empty when loading with missingEnv: "warn";
   * the affected values are then placeholders like "<NAME is unset>", fine for validating, not for running.
   */
  missingEnv: string[];
  /** Where each entry is defined, keyed like "repos/system-local". */
  origins: Record<string, Origin>;
}

const SECTIONS: readonly Section[] = ["repos", "sets", "chains"];
const SINGULAR: Record<Section, string> = { repos: "repo", sets: "set", chains: "chain" };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface Entry {
  section: Section;
  name: string;
  raw: unknown;
  src: Source;
}

export async function loadConfig(options: LoadOptions): Promise<LoadResult> {
  const env = options.env ?? process.env;
  const missingSeverity: Severity = options.missingEnv === "warn" ? "warning" : "error";
  const diagnostics: Diagnostic[] = [];
  const referenced = new Set<string>();
  const missing = new Set<string>();
  const origins: Record<string, Origin> = {};

  const add = (severity: Severity, message: string, src?: Source, pos?: { line: number; col: number }) => {
    const d: Diagnostic = { severity, message };
    if (src) d.file = src.file;
    if (pos) {
      d.line = pos.line;
      d.col = pos.col;
    }
    diagnostics.push(d);
  };

  const discovered = await discover(options.path);
  if ("error" in discovered) {
    diagnostics.push({ severity: "error", message: discovered.error });
    return { ok: false, diagnostics, files: [], referencedEnv: [], missingEnv: [], origins };
  }
  const files = discovered.files;

  /* ---- 1. parse every file on its own, expand ${VAR}, collect entries by name ---- */

  const entries = new Map<string, Entry>();

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lc = new LineCounter();
    const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false, merge: true });
    const src: Source = { file, doc, lc };

    const textLines = text.split(/\r?\n/);
    for (const e of doc.errors) {
      let message = e.message;
      const pos = positionAt(src, e.pos[0]);
      if (e.code === "BAD_ALIAS") message += " (if this is a glob pattern, wrap it in quotes)";
      else if (textLines[pos.line - 1]?.includes("${")) {
        message += " (inside {} or [] a ${VAR} reference must be quoted)";
      }
      add("error", message, src, pos);
    }
    for (const w of doc.warnings) add("warning", w.message, src, positionAt(src, w.pos[0]));

    // yaml reports an unknown alias only when the document is converted, and then by throwing.
    // Check for it up front: an unquoted glob such as **/venv is read as an alias.
    visit(doc, {
      Alias(_key, node) {
        if (node.resolve(doc) === undefined) {
          add(
            "error",
            `unknown alias "*${node.source}" (if this is a glob pattern, wrap it in quotes)`,
            src,
            positionAt(src, node.range?.[0] ?? 0),
          );
        }
      },
    });
    if (diagnostics.some((d) => d.severity === "error" && d.file === file)) continue;

    expandDocument(doc, env, referenced, missing, missingSeverity, (sev, msg, offset) =>
      add(sev, msg, src, positionAt(src, offset)),
    );

    const data: unknown = doc.toJS();
    if (data === null || data === undefined) continue; // empty or comment-only file
    if (!isPlainObject(data)) {
      add("error", `top level must be a mapping with the sections: ${SECTIONS.join(", ")}`, src, locate(src, []));
      continue;
    }

    for (const key of Object.keys(data)) {
      if (!(SECTIONS as readonly string[]).includes(key)) {
        add("error", `unknown top-level key "${key}" (expected: ${SECTIONS.join(", ")})`, src, locate(src, [key], "key"));
      }
    }

    for (const section of SECTIONS) {
      const value = data[section];
      if (value === null || value === undefined) continue;
      if (!isPlainObject(value)) {
        add("error", `"${section}" must be a mapping of names to definitions`, src, locate(src, [section]));
        continue;
      }
      for (const name of Object.keys(value)) {
        const keyPos = locate(src, [section, name], "key");
        if (!NAME_RE.test(name)) {
          add("error", `invalid ${SINGULAR[section]} name "${name}": use letters, digits, ".", "_" and "-"`, src, keyPos);
          continue;
        }
        const id = `${section}/${name}`;
        const previous = origins[id];
        if (previous) {
          const rel = displayPath(previous.file, process.cwd());
          add(
            "error",
            `duplicate ${SINGULAR[section]} "${name}" (already defined at ${rel}:${previous.line}:${previous.col})`,
            src,
            keyPos,
          );
          continue;
        }
        origins[id] = { file, ...keyPos };
        entries.set(id, { section, name, raw: value[name], src });
      }
    }
  }

  /* ---- 2. validate each entry against its schema ---- */

  const reportIssue = (entry: Entry, issue: Issue, severity: Severity = "error") => {
    const pos = locate(entry.src, [entry.section, entry.name, ...issue.path], issue.at);
    add(severity, issue.message, entry.src, pos);
  };

  const declaredRepos = new Set<string>();
  const declaredSets = new Set<string>();
  const repos = new Map<string, Repo>();
  const sets = new Map<string, BackupSet>();
  const chains = new Map<string, ChainDraft>();
  const chainEntries = new Map<string, Entry>();

  for (const entry of entries.values()) {
    const { section, name, raw } = entry;

    if (section === "repos") {
      declaredRepos.add(name);
      const r = RepoSchema.safeParse(raw);
      if (!r.success) fromZod(r.error, [], raw).forEach((i) => reportIssue(entry, i));
      else repos.set(name, normalizeRepo(r.data));
    } else if (section === "sets") {
      declaredSets.add(name);
      const r = SetSchema.safeParse(raw);
      if (!r.success) fromZod(r.error, [], raw).forEach((i) => reportIssue(entry, i));
      else sets.set(name, normalizeSet(r.data));
    } else {
      const r = ChainSchema.safeParse(raw);
      if (!r.success) {
        fromZod(r.error, [], raw).forEach((i) => reportIssue(entry, i));
        // still check the steps that are there so one run reports as much as possible
        if (isPlainObject(raw) && Array.isArray(raw.steps)) {
          raw.steps.forEach((s, i) => validateStep(s, ["steps", i]).issues.forEach((x) => reportIssue(entry, x)));
        }
        continue;
      }
      const steps = r.data.steps.map((s, i) => {
        const result = validateStep(s, ["steps", i]);
        result.issues.forEach((x) => reportIssue(entry, x));
        return result.step;
      });
      chains.set(name, { header: normalizeChainHeader(r.data), steps });
      chainEntries.set(name, entry);
    }
  }

  /* ---- 3. checks that look across entries ---- */

  checkSemantics({ declaredRepos, declaredSets, repos, chains }, (section, name, p, message, severity = "error", at) => {
    const entry = entries.get(`${section}/${name}`);
    if (entry) reportIssue(entry, { path: p, message, ...(at ? { at } : {}) }, severity);
  });

  /* ---- result ---- */

  // file order (the merge order), then position; messages without a file come first
  const fileIndex = new Map(files.map((f, i) => [f, i]));
  const rank = (d: Diagnostic) => (d.file === undefined ? -1 : (fileIndex.get(d.file) ?? files.length));
  diagnostics.sort(
    (a, b) => rank(a) - rank(b) || (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0),
  );

  const ok = !diagnostics.some((d) => d.severity === "error");
  const result: LoadResult = {
    ok,
    diagnostics,
    files,
    referencedEnv: [...referenced].sort(),
    missingEnv: [...missing].sort(),
    origins,
  };

  if (ok) {
    const chainsOut: Record<string, Chain> = {};
    for (const [name, draft] of chains) {
      chainsOut[name] = { ...draft.header, steps: draft.steps as NonNullable<(typeof draft.steps)[number]>[] };
    }
    result.config = {
      repos: Object.fromEntries(repos),
      sets: Object.fromEntries(sets),
      chains: chainsOut,
    };
  }
  return result;
}

/** Expands ${VAR} in every string value of a document (keys are left alone). */
function expandDocument(
  doc: Document.Parsed,
  env: Record<string, string | undefined>,
  referenced: Set<string>,
  missing: Set<string>,
  missingSeverity: Severity,
  report: (severity: Severity, message: string, offset: number) => void,
): void {
  visit(doc, {
    Scalar(key, node) {
      if (key === "key" || typeof node.value !== "string" || !node.value.includes("$")) return;
      const offset = node.range?.[0] ?? 0;
      // a visible placeholder keeps "unset" from also being reported as "empty" further down;
      // the placeholder never reaches a usable config because an unset variable is reported
      // (as an error, or as a warning in validate-only runs)
      const res = expandString(node.value, env, (name) => `<${name} is unset>`);
      res.referenced.forEach((n) => referenced.add(n));
      for (const msg of res.errors) report("error", msg, offset);
      for (const name of res.missing) {
        missing.add(name);
        report(
          missingSeverity,
          `environment variable ${name} is not set (write \${${name}:-default} to give it a default)`,
          offset,
        );
      }
      node.value = res.value;
    },
  });
}

type Discovered = { files: string[] } | { error: string };

async function discover(target: string): Promise<Discovered> {
  let info;
  try {
    info = await stat(target);
  } catch {
    return { error: `config path not found: ${target}` };
  }
  if (info.isFile()) return { files: [path.resolve(target)] };
  if (!info.isDirectory()) return { error: `config path is neither a file nor a directory: ${target}` };

  const names = (await readdir(target)).filter(
    (n) => /\.ya?ml$/i.test(n) && !n.startsWith(".") && !n.endsWith("~"),
  );
  const files: string[] = [];
  for (const n of names.sort()) {
    const full = path.resolve(target, n);
    try {
      if ((await stat(full)).isFile()) files.push(full);
    } catch {
      /* broken symlink: skip */
    }
  }
  if (files.length === 0) return { error: `no .yaml or .yml files found in ${target}` };
  return { files };
}

// re-exported for tests that want to build sources by hand
export type { Source };
export { isMap, isScalar };
