import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  describeStep,
  listDir,
  listSnapshots,
  MAX_DIR_ENTRIES,
  SNAPSHOT_ID,
  type BrowseProblem,
  type BrowseResult,
  type Config,
  type ResticContext,
  type Runner,
  type RunnerEvent,
  type Scheduler,
  type Store,
} from "@rescade/core";
import type { RepoStates } from "./repos.js";
import { arrayOf, ref, schemas } from "./schemas.js";

/** What `GET /status` shows about the daemon itself. */
export interface DaemonStatus {
  version: string;
  startedAt: number;
  config: {
    path: string;
    loadedAt: number;
    lastReload?: { at: number; ok: boolean; errors: string[] };
  };
}

export interface ServerDeps {
  /** The current config; it changes on reload. */
  config: () => Config;
  status: () => DaemonStatus;
  runner: Runner;
  scheduler: Scheduler;
  store: Store;
  repos: RepoStates;
  /** How to run restic for browsing snapshots; the repos come from the current config. */
  restic: Pick<ResticContext, "binary" | "env" | "killGraceMs" | "repoCheckTimeoutMs">;
  token: string;
  /** Host header values to accept, lower case; may be filled in after the server starts listening. */
  allowedHosts: Set<string>;
  corsOrigins: Set<string>;
  logger: FastifyBaseLogger;
  /** Interval of SSE keep-alive comments. */
  heartbeatMs?: number;
  /** The built web UI; without it only the API is served. */
  webDir?: string;
}

const id = { type: "integer", minimum: 1 } as const;
const idParams = { type: "object", properties: { id }, required: ["id"] } as const;

const errorText: Record<number, string> = {
  400: "Invalid parameters",
  401: "Missing or wrong API token",
  403: "Host not allowed",
  404: "Not found",
  409: "The run is not in progress",
  502: "restic failed",
  503: "The daemon is stopping",
  504: "The repo did not answer in time",
};

/**
 * Response schemas by status code; every route can also answer 401 and 403 from the access check.
 * An error is its code, or the code with a description of its own.
 */
function responses(
  code: number,
  description: string,
  schema: object,
  ...errors: Array<number | [number, string]>
): Record<number, unknown> {
  const r: Record<number, unknown> = { [code]: { description, ...schema } };
  for (const e of [...errors, 401, 403]) {
    const [c, text] = typeof e === "number" ? [e, errorText[e]] : e;
    r[c] = { description: text, ...ref("Error") };
  }
  return r;
}

/** HTTP status of a failed snapshot query. */
const browseStatus: Record<BrowseProblem, number> = {
  "not-found": 404,
  locked: 409,
  failed: 502,
  "no-answer": 504,
  cancelled: 503,
};
const browseErrors: Array<number | [number, string]> = [
  400,
  [404, "No such repo, snapshot or path"],
  [409, "An exclusive lock (prune) held the repo longer than restic waits"],
  502,
  504,
];

const nameParams = { type: "object", properties: { name: { type: "string" } }, required: ["name"] } as const;

/** The API lives under this prefix; other paths are the web UI, routed in the browser. */
export const API_PREFIX = "/api";
/** Served without the token (they hold no secrets; a browser cannot send it), but behind the Host check. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`;
export const DOCS_PATH = `${API_PREFIX}/docs`;
/** For container health checks: tells nothing but that the daemon answers. */
export const HEALTH_PATH = `${API_PREFIX}/health`;

const isApi = (p: string): boolean => p === API_PREFIX || p.startsWith(`${API_PREFIX}/`);
const needsToken = (p: string): boolean =>
  isApi(p) && p !== OPENAPI_PATH && p !== HEALTH_PATH && p !== DOCS_PATH && !p.startsWith(`${DOCS_PATH}/`);

/**
 * The HTTP API and the web UI. Every request needs the Host check; API requests also need the bearer token,
 * except CORS preflight and the OpenAPI document with Swagger UI.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: true }),
    // SSE connections stay open; close them with the server
    forceCloseConnections: true,
  });

  // swagger has to be loaded before the routes to see them
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "rescade API",
        version: "1",
        description:
          'Runs and history of rescade cascades. Errors are `{ "error": "..." }`; times are epoch milliseconds.',
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    // components named by $id instead of def-0, def-1...
    refResolver: { buildLocalReference: (json, _base, _fragment, i) => String(json.$id ?? `def-${i}`) },
  });
  // the token for "Try it out" is entered with Authorize
  await app.register(swaggerUi, { routePrefix: DOCS_PATH });
  for (const schema of schemas) app.addSchema(schema);

  const expected = digest(deps.token);
  app.addHook("onRequest", async (request, reply) => {
    const host = (request.headers.host ?? "").toLowerCase();
    if (!deps.allowedHosts.has(host)) return reply.code(403).send({ error: `host "${host}" is not allowed` });

    const origin = request.headers.origin;
    if (origin !== undefined && deps.corsOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin).header("vary", "Origin");
      if (request.method === "OPTIONS") {
        return reply
          .code(204)
          .header("access-control-allow-methods", "GET, POST")
          .header("access-control-allow-headers", "Authorization, Content-Type")
          .header("access-control-max-age", "600")
          .send();
      }
    }
    // the matched route cannot be dressed up like a raw path; the path covers /api/... caught by the UI's wildcard
    const route = request.routeOptions.url;
    if (!(route !== undefined && needsToken(route)) && !needsToken(request.url.split("?")[0]!)) return;

    const auth = request.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!timingSafeEqual(digest(token), expected)) {
      return reply.code(401).header("www-authenticate", "Bearer").send({ error: "missing or wrong API token" });
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const code = error.statusCode ?? 500;
    if (code >= 500) request.log.error({ err: error, url: request.url }, "request failed");
    return reply.code(code).send({ error: error.message });
  });
  if (deps.webDir !== undefined) {
    await app.register(fastifyStatic, {
      root: deps.webDir,
      cacheControl: false,
      // file names under assets/ carry a content hash
      setHeaders: (reply, file) =>
        reply.header(
          "cache-control",
          path.relative(deps.webDir!, file).startsWith(`assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
        ),
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const p = request.url.split("?")[0]!;
    // a page of the UI, not a missing file
    if (deps.webDir !== undefined && request.method === "GET" && !isApi(p) && !path.posix.basename(p).includes(".")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: `no route ${request.method} ${request.url}` });
  });

  app.get(OPENAPI_PATH, { schema: { hide: true } }, async () => app.swagger());

  app.get(
    HEALTH_PATH,
    {
      schema: {
        summary: "Whether the daemon answers; needs no token",
        security: [],
        response: {
          200: {
            description: "The daemon is up",
            type: "object",
            properties: { ok: { const: true } },
            required: ["ok"],
          },
          403: { description: errorText[403], ...ref("Error") },
        },
      },
    },
    async () => ({ ok: true }),
  );

  app.get(
    `${API_PREFIX}/status`,
    {
      schema: {
        summary: "The daemon: version, uptime, the config in use and the outcome of the latest reload",
        response: responses(200, "Daemon status", ref("Status")),
      },
    },
    async () => deps.status(),
  );

  app.get(
    `${API_PREFIX}/cascades`,
    {
      schema: {
        summary: "Cascades of the current config with their next, active and last runs",
        response: responses(200, "Cascades in config order", arrayOf("Cascade")),
      },
    },
    async () => {
      const config = deps.config();
      const active = new Map(deps.runner.running().map((r) => [r.cascade, r]));
      return Object.entries(config.cascades).map(([name, c]) => ({
        name,
        description: c.description ?? null,
        schedule: c.schedule,
        timezone: c.timezone ?? null,
        onBusy: c.onBusy,
        waitTimeoutMs: c.waitTimeoutMs ?? null,
        steps: c.steps.map((s) => ({ type: s.type, label: describeStep(s) })),
        nextRun: deps.scheduler.nextRun(name)?.getTime() ?? null,
        active: active.get(name) ?? null,
        lastRun: deps.store.runs({ cascade: name, limit: 1 })[0] ?? null,
      }));
    },
  );

  app.post<{ Params: { name: string } }>(
    `${API_PREFIX}/cascades/:name/run`,
    {
      schema: {
        summary: "Start a cascade",
        description:
          "The run is `skipped` with a reason when the cascade is already running or `on-busy: skip` finds its repos busy.",
        params: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        response: responses(202, "The new run", ref("Run"), 404, 503),
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      if (!deps.config().cascades[name]) return reply.code(404).send({ error: `unknown cascade "${name}"` });
      if (deps.runner.isStopping) return reply.code(503).send({ error: "the daemon is stopping" });
      const run = deps.runner.trigger(name, "manual");
      request.log.info({ run: run.id, cascade: name, status: run.status }, "manual run requested");
      return reply.code(202).send(run);
    },
  );

  app.get<{ Querystring: { cascade?: string; limit?: number; before?: number } }>(
    `${API_PREFIX}/runs`,
    {
      schema: {
        summary: "Runs, newest first",
        querystring: {
          type: "object",
          properties: {
            cascade: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 50" },
            before: { ...id, description: "Only runs with a smaller id, for paging" },
          },
          additionalProperties: false,
        },
        response: responses(200, "Runs without their steps", arrayOf("Run"), 400),
      },
    },
    async (request) => {
      const { cascade, limit, before } = request.query;
      return deps.store.runs({ cascade, limit, beforeId: before });
    },
  );

  app.get<{ Params: { id: number } }>(
    `${API_PREFIX}/runs/:id`,
    {
      schema: {
        summary: "A run with its steps",
        params: idParams,
        response: responses(200, "The run", ref("RunWithSteps"), 400, 404),
      },
    },
    async (request, reply) => {
      const run = deps.store.run(request.params.id);
      return run ?? reply.code(404).send({ error: `no run ${request.params.id}` });
    },
  );

  app.get<{ Params: { id: number }; Querystring: { step?: number; after?: number } }>(
    `${API_PREFIX}/runs/:id/log`,
    {
      schema: {
        summary: "Log lines of a run, of one step with `step`",
        description:
          "To follow a run without losing or repeating lines, subscribe to `/api/events?run=` first, then ask for the log " +
          "and drop `log` events with an id not greater than the last line received. `after` catches up after a reconnect.",
        params: idParams,
        querystring: {
          type: "object",
          properties: {
            step: { type: "integer", minimum: 0, description: "Step index" },
            after: { type: "integer", minimum: 0, description: "Only lines with a greater id" },
          },
          additionalProperties: false,
        },
        response: responses(200, "Log lines in order", arrayOf("LogLine"), 400, 404),
      },
    },
    async (request, reply) => {
      if (!deps.store.run(request.params.id)) return reply.code(404).send({ error: `no run ${request.params.id}` });
      const { step, after } = request.query;
      return deps.store.log(request.params.id, { step, after });
    },
  );

  app.post<{ Params: { id: number } }>(
    `${API_PREFIX}/runs/:id/cancel`,
    {
      schema: {
        summary: "Cancel a queued or running run",
        params: idParams,
        response: responses(
          202,
          "Cancelling; the run ends as `cancelled`",
          { type: "object", properties: { cancelling: { const: true } }, required: ["cancelling"] },
          400,
          404,
          409,
        ),
      },
    },
    async (request, reply) => {
      const { id: runId } = request.params;
      if (deps.runner.cancel(runId)) {
        request.log.info({ run: runId }, "cancel requested");
        return reply.code(202).send({ cancelling: true });
      }
      const run = deps.store.run(runId);
      if (!run) return reply.code(404).send({ error: `no run ${runId}` });
      return reply.code(409).send({ error: `run ${runId} is not in progress (${run.status})` });
    },
  );

  app.get(
    `${API_PREFIX}/repos`,
    {
      schema: {
        summary: "Last known state of each repo",
        response: responses(200, "Repos in config order", arrayOf("Repo")),
      },
    },
    async () => deps.repos.list(deps.config(), deps.runner.locks),
  );

  /**
   * Runs a snapshot query on a repo of the current config. No repo mutex is taken: restic's own shared lock
   * works next to a backup. restic is stopped when the client goes away.
   */
  async function browse<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    name: string,
    query: (ctx: ResticContext) => Promise<BrowseResult<T>>,
  ): Promise<T | FastifyReply> {
    const repos = deps.config().repos;
    if (!repos[name]) return reply.code(404).send({ error: `unknown repo "${name}"` });
    const ac = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) ac.abort();
    };
    reply.raw.on("close", onClose);
    try {
      const r = await query({ ...deps.restic, repos, signal: ac.signal });
      if (r.ok) return r.value;
      if (r.problem !== "cancelled") request.log.warn({ repo: name, problem: r.problem }, r.reason);
      return reply.code(browseStatus[r.problem]).send({ error: r.reason });
    } finally {
      reply.raw.off("close", onClose);
    }
  }

  app.get<{ Params: { name: string } }>(
    `${API_PREFIX}/repos/:name/snapshots`,
    {
      schema: {
        summary: "Snapshots of a repo, newest first",
        description:
          "Runs `restic snapshots`. Takes no rescade lock: it works during a backup and waits briefly for a prune.",
        params: nameParams,
        response: responses(200, "Snapshots", arrayOf("Snapshot"), ...browseErrors),
      },
    },
    async (request, reply) => browse(request, reply, request.params.name, (ctx) => listSnapshots(ctx, request.params.name)),
  );

  app.get<{ Params: { name: string; id: string }; Querystring: { path: string } }>(
    `${API_PREFIX}/repos/:name/snapshots/:id/ls`,
    {
      schema: {
        summary: "What is directly in a directory of a snapshot",
        description:
          "Runs `restic ls` for one directory, so a large tree is browsed a level at a time. " +
          `At most ${MAX_DIR_ENTRIES} entries come back (\`truncated\` tells). File names from backups are visible to anyone with the token.`,
        params: {
          type: "object",
          properties: {
            name: { type: "string" },
            id: { type: "string", pattern: SNAPSHOT_ID.source, description: "Snapshot id, full or at least 8 characters" },
          },
          required: ["name", "id"],
        },
        querystring: {
          type: "object",
          properties: { path: { type: "string", pattern: "^/", default: "/", description: "Absolute path in the snapshot" } },
          additionalProperties: false,
        },
        response: responses(200, "The directory", ref("SnapshotDir"), ...browseErrors),
      },
    },
    async (request, reply) => {
      const { name, id: snapshot } = request.params;
      return browse(request, reply, name, (ctx) => listDir(ctx, name, snapshot, request.query.path));
    },
  );

  app.get<{ Querystring: { run?: number; cascade?: string } }>(
    `${API_PREFIX}/events`,
    {
      schema: {
        summary: "Server-sent events",
        description:
          "Every event is `event: <kind>` (`run`, `step`, `log`, `repo`) with the JSON in `data:`. " +
          "With `run` or `cascade` only events of those runs come, without `repo`. Comments keep the connection alive.",
        querystring: {
          type: "object",
          properties: {
            run: { ...id, description: "Events of this run" },
            cascade: { type: "string", description: "Events of this cascade's runs" },
          },
          additionalProperties: false,
        },
        response: responses(
          200,
          "The event stream",
          { content: { "text/event-stream": { schema: ref("Event") } } },
          400,
        ),
      },
    },
    (request, reply) => streamEvents(deps, request, reply),
  );

  return app;
}

/**
 * Server-sent events: every runner event as `event: <kind>` with JSON data.
 * `?run=` keeps the events of one run, `?cascade=` those of the cascade's runs (repo events are left out).
 */
function streamEvents(
  deps: ServerDeps,
  request: FastifyRequest<{ Querystring: { run?: number; cascade?: string } }>,
  reply: FastifyReply,
): void {
  const { run, cascade } = request.query;
  const runsOfCascade = new Set<number>();
  const wanted = (e: RunnerEvent): boolean => {
    if (run === undefined && cascade === undefined) return true;
    const runId =
      e.kind === "run" ? e.run.id : e.kind === "step" ? e.step.runId : e.kind === "log" ? e.runId : undefined;
    if (runId === undefined) return false;
    if (run !== undefined) return runId === run;
    // a run's own event always comes before its steps and logs
    if (e.kind === "run" && e.run.cascade === cascade) runsOfCascade.add(runId);
    return runsOfCascade.has(runId);
  };

  reply.hijack();
  const res = reply.raw;
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (typeof value === "string") headers[name] = value;
  }
  res.writeHead(200, headers);
  res.write(": connected\n\n");

  const unsubscribe = deps.runner.subscribe((e) => {
    if (wanted(e)) res.write(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), deps.heartbeatMs ?? 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
