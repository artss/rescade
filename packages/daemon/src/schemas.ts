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
    cascade: { type: "string" },
    trigger: { type: "string", enum: ["schedule", "manual"] },
    status: {
      ...state,
      description: "`queued`: a step waits for busy repos; `interrupted`: the daemon stopped during the run",
    },
    reason: { type: "string", description: "Why the run did not succeed or waits" },
    startedAt: epochMs,
    finishedAt: epochMs,
  },
  required: ["id", "cascade", "trigger", "status", "startedAt"],
} as const;

const Step = {
  $id: "Step",
  type: "object",
  properties: {
    runId: { type: "integer" },
    index: { type: "integer" },
    type: stepType,
    label: { type: "string" },
    status: state,
    exitCode: { type: "integer" },
    startedAt: epochMs,
    durationMs: { type: "integer" },
    reason: { type: "string" },
    stderrTail: { type: "array", items: { type: "string" }, description: "Last stderr lines of a failed process" },
    summary: { type: "object", additionalProperties: true, description: "backup: restic's JSON summary" },
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
    step: { type: "integer" },
    ts: epochMs,
    stream: {
      type: "string",
      enum: ["stdout", "stderr", "info"],
      description: "`info` lines come from rescade itself",
    },
    line: { type: "string" },
  },
  required: ["step", "ts", "stream", "line"],
} as const;

const Cascade = {
  $id: "Cascade",
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: ["string", "null"] },
    schedule: { type: "array", items: { type: "string" }, description: "Cron expressions; empty: manual runs only" },
    timezone: { type: ["string", "null"] },
    onBusy: { type: "string", enum: ["skip", "wait"] },
    waitTimeoutMs: { type: ["integer", "null"] },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: { type: stepType, label: { type: "string" } },
        required: ["type", "label"],
      },
    },
    nextRun: { type: ["integer", "null"], description: "Epoch milliseconds of the next scheduled run" },
    active: nullable("Run"),
    lastRun: nullable("Run"),
  },
  required: [
    "name",
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
  properties: { runId: { type: "integer" }, cascade: { type: "string" } },
  required: ["runId", "cascade"],
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
  Run,
  Step,
  RunWithSteps,
  LogLine,
  Cascade,
  LockOwner,
  ResticLock,
  RepoLockList,
  Repo,
  RepoCheck,
  RunEvent,
  StepEvent,
  LogEvent,
  RepoEvent,
  Event,
];

export const ref = (id: string) => ({ $ref: `${id}#` });
export const arrayOf = (id: string) => ({ type: "array", items: ref(id) });
