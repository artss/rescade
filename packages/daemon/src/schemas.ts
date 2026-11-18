/**
 * JSON schemas of the API responses. Fastify serializes responses by them (fields left out of a schema
 * are dropped, missing required ones fail the request) and @fastify/swagger puts them into the OpenAPI
 * document as components named by `$id`.
 */

const epochMs = { type: "integer", description: "Epoch milliseconds" } as const;
const nullable = (ref: string) => ({ anyOf: [{ $ref: `${ref}#` }, { type: "null" }] });

const stepType = { type: "string", enum: ["backup", "retain", "prune", "check", "copy", "run"] } as const;
const runStatus = ["success", "warning", "failed", "cancelled", "skipped"] as const;
const state = { type: "string", enum: ["queued", "running", ...runStatus, "interrupted"] } as const;
const repoProblem = ["unreachable", "wrong-password", "init-failed", "error", "cancelled"] as const;

const ErrorBody = {
  $id: "Error",
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
} as const;

const Run = {
  $id: "Run",
  type: "object",
  properties: {
    id: { type: "integer" },
    cascade: { type: "string", description: "Absent for a restore" },
    restore: { $ref: "Restore#" },
    trigger: { type: "string", enum: ["schedule", "manual"] },
    rerunOf: { type: "integer", description: "A rerun: the run whose failed step it starts from" },
    fromStep: {
      type: "integer",
      minimum: 0,
      description: "A rerun: index of the first step it runs; the steps before it were done in `rerunOf` and are not listed",
    },
    status: {
      ...state,
      description: "`queued`: a step waits for busy repos; `interrupted`: the daemon stopped during the run",
    },
    reason: { type: "string", description: "Why the run did not succeed or waits" },
    startedAt: epochMs,
    finishedAt: epochMs,
  },
  required: ["id", "trigger", "status", "startedAt"],
} as const;

const Restore = {
  $id: "Restore",
  type: "object",
  description: "A restore run: what is restored and where to",
  properties: {
    repo: { type: "string" },
    snapshot: { type: "string", description: "The snapshot id as given" },
    paths: { type: "array", items: { type: "string" }, description: "Empty: the whole snapshot" },
    target: { type: "string", description: "`<restore dir>/<short id>`; the snapshot's paths are kept below it" },
  },
  required: ["repo", "snapshot", "paths", "target"],
} as const;

const Step = {
  $id: "Step",
  type: "object",
  properties: {
    runId: { type: "integer" },
    index: { type: "integer" },
    type: { type: "string", enum: [...stepType.enum, "restore"] },
    label: { type: "string" },
    status: state,
    exitCode: { type: "integer" },
    startedAt: epochMs,
    durationMs: { type: "integer" },
    reason: { type: "string" },
    stderrTail: { type: "array", items: { type: "string" }, description: "Last stderr lines of a failed process" },
    summary: { type: "object", additionalProperties: true, description: "backup, restore: restic's JSON summary" },
    repo: {
      type: "string",
      description: "backup: the repo the snapshot (`summary.snapshot_id`) goes to; restore: the repo it comes from",
    },
  },
  required: ["runId", "index", "type", "label", "status"],
} as const;

const RunWithSteps = {
  $id: "RunWithSteps",
  type: "object",
  properties: { ...Run.properties, steps: { type: "array", items: { $ref: "Step#" } } },
  required: [...Run.required, "steps"],
} as const;

const LogLine = {
  $id: "LogLine",
  type: "object",
  properties: {
    id: { type: "integer", description: "Grows with every line; `after` in the log request continues from it" },
    step: { type: "integer" },
    ts: epochMs,
    stream: {
      type: "string",
      enum: ["stdout", "stderr", "info"],
      description: "`info` lines come from rescade itself",
    },
    line: { type: "string" },
  },
  required: ["id", "step", "ts", "stream", "line"],
} as const;

const strings = { type: "array", items: { type: "string" } } as const;

const Retention = {
  $id: "Retention",
  type: "object",
  description: "The repo's `retention`: how many snapshots `restic forget` keeps",
  properties: {
    last: { type: "integer" },
    hourly: { type: "integer" },
    daily: { type: "integer" },
    weekly: { type: "integer" },
    monthly: { type: "integer" },
    yearly: { type: "integer" },
    within: { type: "string", description: 'restic duration such as "2y6m"' },
  },
} as const;

const CascadeStep = {
  $id: "CascadeStep",
  type: "object",
  description: "A step of the config. `type`, `label` and `name` are always there, the rest depends on `type`.",
  properties: {
    type: stepType,
    label: { type: "string", description: "`name`, or a summary of the step" },
    name: { type: ["string", "null"] },
    set: { type: "string", description: "backup" },
    repo: { type: "string", description: "backup, retain, prune, check" },
    include: { ...strings, description: "backup: paths of the set" },
    exclude: { ...strings, description: "backup: exclude patterns of the set" },
    tags: { ...strings, description: "backup: tags of the set and of the step" },
    oneFileSystem: { type: "boolean", description: "backup" },
    excludeCaches: { type: "boolean", description: "backup" },
    retention: { ...nullable("Retention"), description: "retain: the policy of the repo" },
    maxUnused: { type: ["string", "null"], description: "prune" },
    readDataSubset: { type: ["string", "null"], description: "check" },
    from: { type: "string", description: "copy" },
    to: { type: "string", description: "copy" },
    shell: { type: "boolean", description: "run" },
    command: { type: "string", description: "run with `shell: true`: the script" },
    argv: { ...strings, description: "run with `shell: false`: the program and its arguments" },
    cwd: { type: ["string", "null"], description: "run" },
    env: { ...strings, description: "run: names of the variables it sets, without values" },
    timeoutMs: { type: "integer", description: "run" },
    lock: { ...strings, description: "run: repos whose mutex it holds" },
  },
  required: ["type", "label", "name"],
} as const;

const Cascade = {
  $id: "Cascade",
  type: "object",
  properties: {
    name: { type: "string" },
    group: { type: ["string", "null"], description: "Display group; null: no group" },
    description: { type: ["string", "null"] },
    schedule: { type: "array", items: { type: "string" }, description: "Cron expressions; empty: manual runs only" },
    timezone: { type: ["string", "null"] },
    onBusy: { type: "string", enum: ["skip", "wait"] },
    waitTimeoutMs: { type: ["integer", "null"] },
    steps: { type: "array", items: { $ref: "CascadeStep#" } },
    nextRun: { type: ["integer", "null"], description: "Epoch milliseconds of the next scheduled run" },
    active: nullable("Run"),
    lastRun: nullable("Run"),
  },
  required: [
    "name",
    "group",
    "description",
    "schedule",
    "timezone",
    "onBusy",
    "waitTimeoutMs",
    "steps",
    "nextRun",
    "active",
    "lastRun",
  ],
} as const;

const LockOwner = {
  $id: "LockOwner",
  type: "object",
  description: "The rescade run whose step holds a repo",
  properties: { runId: { type: "integer" }, cascade: { type: "string", description: "Absent for a restore" } },
  required: ["runId"],
} as const;

const ResticLock = {
  $id: "ResticLock",
  type: "object",
  properties: {
    id: { type: "string" },
    time: { ...epochMs, description: "Epoch milliseconds; a live restic refreshes its locks every 5 minutes" },
    exclusive: { type: "boolean" },
    hostname: { type: "string" },
    username: { type: "string" },
    pid: { type: "integer" },
    stale: { type: "boolean", description: "Older than 30 minutes, restic's own limit" },
  },
  required: ["id", "time", "exclusive", "hostname", "username", "pid", "stale"],
} as const;

const RepoLockList = {
  $id: "RepoLockList",
  type: "object",
  description: "restic lock files found at the last check",
  properties: {
    count: { type: "integer", description: "All lock files; details are read for the first 10" },
    locks: { type: "array", items: { $ref: "ResticLock#" } },
    error: { type: "string", description: "The locks could not be read; the repo itself answered" },
  },
  required: ["count", "locks"],
} as const;

const Repo = {
  $id: "Repo",
  type: "object",
  properties: {
    name: { type: "string" },
    location: { type: "string", description: "Repo location with any password in a URL hidden" },
    group: { type: "string", description: "Display group" },
    from: { type: "string" },
    state: { type: "string", enum: ["unknown", "ok", ...repoProblem], description: "`unknown` until checked" },
    reason: { type: "string" },
    checkedAt: epochMs,
    id: { type: "string" },
    chunkerPolynomial: { type: "string" },
    locks: { $ref: "RepoLockList#" },
    lockedBy: { $ref: "LockOwner#" },
  },
  required: ["name", "location", "state"],
} as const;

const RepoCheck = {
  $id: "RepoCheck",
  description: "Outcome of a repo check (`restic cat config`, init when missing, lock files)",
  oneOf: [
    {
      type: "object",
      properties: {
        ok: { const: true },
        config: {
          type: "object",
          properties: { id: { type: "string" }, chunkerPolynomial: { type: "string" } },
          required: ["id", "chunkerPolynomial"],
        },
        initialized: { type: "boolean" },
        locks: { $ref: "RepoLockList#" },
      },
      required: ["ok", "config", "initialized", "locks"],
    },
    {
      type: "object",
      properties: { ok: { const: false }, problem: { type: "string", enum: repoProblem }, reason: { type: "string" } },
      required: ["ok", "problem", "reason"],
    },
  ],
} as const;

const Status = {
  $id: "Status",
  type: "object",
  properties: {
    version: { type: "string" },
    startedAt: { ...epochMs, description: "When the daemon started" },
    config: {
      type: "object",
      properties: {
        path: { type: "string", description: "The config directory or file" },
        loadedAt: { ...epochMs, description: "When the config in use was loaded" },
        lastReload: {
          type: "object",
          description: "The latest reload (SIGHUP); absent until there was one",
          properties: {
            at: epochMs,
            ok: { type: "boolean", description: "false: the new config had errors and the old one stays" },
            errors: { type: "array", items: { type: "string" }, description: "file:line:col: message" },
          },
          required: ["at", "ok", "errors"],
        },
      },
      required: ["path", "loadedAt"],
    },
    restoreDir: {
      type: "string",
      description: "Where snapshots are restored (`<restoreDir>/<short id>`); absent = restore is off",
    },
  },
  required: ["version", "startedAt", "config"],
} as const;

const count = (description: string) => ({ type: "integer", description }) as const;
const nullableMs = (description: string) => ({ type: ["integer", "null"], description: `Epoch milliseconds; ${description}` }) as const;

const Summary = {
  $id: "Summary",
  type: "object",
  description: "Flat counts for dashboards such as the homepage `customapi` widget",
  properties: {
    cascades: count("Cascades in the config"),
    running: count("Runs in progress"),
    queued: count("Runs waiting for busy repos"),
    success: count("Cascades whose latest finished run succeeded"),
    warning: count("Cascades whose latest finished run ended with a warning"),
    failed: count("Cascades whose latest finished run failed or was interrupted"),
    lastRunAt: nullableMs("when the latest finished run ended, null before any"),
    nextRunAt: nullableMs("the nearest scheduled run, null when nothing is scheduled"),
    repos: count("Repos in the config"),
    repoProblems: count("Repos whose last check failed (unreachable, wrong password and the like)"),
  },
  required: [
    "cascades",
    "running",
    "queued",
    "success",
    "warning",
    "failed",
    "lastRunAt",
    "nextRunAt",
    "repos",
    "repoProblems",
  ],
} as const;

const Snapshot = {
  $id: "Snapshot",
  type: "object",
  properties: {
    id: { type: "string" },
    shortId: { type: "string" },
    time: epochMs,
    hostname: { type: "string" },
    username: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    parent: { type: "string" },
    size: { type: "integer", description: "Bytes of the files in the snapshot (restic 0.17+)" },
    files: { type: "integer", description: "Files in the snapshot (restic 0.17+)" },
    dataAdded: { type: "integer", description: "Bytes the backup added to the repo, before compression (restic 0.17+)" },
  },
  required: ["id", "shortId", "time", "hostname", "username", "paths", "tags"],
} as const;

const SnapshotEntry = {
  $id: "SnapshotEntry",
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string", description: "`dir`, `file`, `symlink` and other restic node types" },
    path: { type: "string" },
    size: { type: "integer" },
    mtime: epochMs,
    permissions: { type: "string", description: "e.g. `drwxr-xr-x`" },
    uid: { type: "integer", description: "Numeric owner as stored in the snapshot" },
    gid: { type: "integer", description: "Numeric group as stored in the snapshot" },
  },
  required: ["name", "type", "path"],
} as const;

const SnapshotDir = {
  $id: "SnapshotDir",
  type: "object",
  properties: {
    snapshot: { $ref: "Snapshot#" },
    path: { type: "string", description: "The listed path, normalized" },
    entries: {
      type: "array",
      items: { $ref: "SnapshotEntry#" },
      description: "What is directly in `path`; for a file, the file itself",
    },
    truncated: { type: "boolean", description: "The directory has more than 10000 entries; the rest is left out" },
  },
  required: ["snapshot", "path", "entries", "truncated"],
} as const;

const RunEvent = {
  $id: "RunEvent",
  type: "object",
  properties: { kind: { const: "run" }, run: { $ref: "Run#" } },
  required: ["kind", "run"],
} as const;

const StepEvent = {
  $id: "StepEvent",
  type: "object",
  properties: { kind: { const: "step" }, step: { $ref: "Step#" } },
  required: ["kind", "step"],
} as const;

const LogEvent = {
  $id: "LogEvent",
  type: "object",
  properties: { kind: { const: "log" }, runId: { type: "integer" }, log: { $ref: "LogLine#" } },
  required: ["kind", "runId", "log"],
} as const;

const RepoEvent = {
  $id: "RepoEvent",
  type: "object",
  properties: { kind: { const: "repo" }, repo: { type: "string" }, result: { $ref: "RepoCheck#" }, at: epochMs },
  required: ["kind", "repo", "result", "at"],
} as const;

const Event = {
  $id: "Event",
  description: "Data of one server-sent event; the SSE `event:` field repeats `kind`",
  oneOf: [{ $ref: "RunEvent#" }, { $ref: "StepEvent#" }, { $ref: "LogEvent#" }, { $ref: "RepoEvent#" }],
} as const;

export const schemas = [
  ErrorBody,
  Restore,
  Run,
  Step,
  RunWithSteps,
  LogLine,
  Retention,
  CascadeStep,
  Cascade,
  LockOwner,
  ResticLock,
  RepoLockList,
  Repo,
  RepoCheck,
  Status,
  Summary,
  Snapshot,
  SnapshotEntry,
  SnapshotDir,
  RunEvent,
  StepEvent,
  LogEvent,
  RepoEvent,
  Event,
];

export const ref = (id: string) => ({ $ref: `${id}#` });
export const arrayOf = (id: string) => ({ type: "array", items: ref(id) });
