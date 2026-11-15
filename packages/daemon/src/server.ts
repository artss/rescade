import { createHash, timingSafeEqual } from "node:crypto";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describeStep, type Config, type Runner, type RunnerEvent, type Scheduler, type Store } from "@rescade/core";
import type { RepoStates } from "./repos.js";
import { arrayOf, ref, schemas } from "./schemas.js";

export interface ServerDeps {
  /** The current config; it changes on reload. */
  config: () => Config;
  runner: Runner;
  scheduler: Scheduler;
  store: Store;
  repos: RepoStates;
  token: string;
  /** Host header values to accept, lower case; may be filled in after the server starts listening. */
  allowedHosts: Set<string>;
  corsOrigins: Set<string>;
  logger: FastifyBaseLogger;
  /** Interval of SSE keep-alive comments. */
  heartbeatMs?: number;
}

const id = { type: "integer", minimum: 1 } as const;
const idParams = { type: "object", properties: { id }, required: ["id"] } as const;

const errorText: Record<number, string> = {
  400: "Invalid parameters",
  401: "Missing or wrong API token",
  403: "Host not allowed",
  404: "Not found",
  409: "The run is not in progress",
  503: "The daemon is stopping",
};

/** Response schemas by status code; every route can also answer 401 and 403 from the access check. */
function responses(code: number, description: string, schema: object, ...errors: number[]): Record<number, unknown> {
  const r: Record<number, unknown> = { [code]: { description, ...schema } };
  for (const c of [...errors, 401, 403]) r[c] = { description: errorText[c], ...ref("Error") };
  return r;
}

/** Served without the token (they hold no secrets; a browser cannot send it), but behind the Host check. */
export const OPENAPI_PATH = "/openapi.json";
export const DOCS_PATH = "/docs";

const isPublic = (route: string | undefined): boolean =>
  route === OPENAPI_PATH || route === DOCS_PATH || route?.startsWith(`${DOCS_PATH}/`) === true;

/**
 * The HTTP API. Every request needs the Host check and the bearer token, except CORS preflight
 * and the OpenAPI document with Swagger UI.
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
    if (isPublic(request.routeOptions.url)) return;

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
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: `no route ${request.method} ${request.url}` }));

  app.get(OPENAPI_PATH, { schema: { hide: true } }, async () => app.swagger());

  app.get(
    "/cascades",
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
    "/cascades/:name/run",
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
    "/runs",
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
    "/runs/:id",
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

  app.get<{ Params: { id: number }; Querystring: { step?: number } }>(
    "/runs/:id/log",
    {
      schema: {
        summary: "Log lines of a run, of one step with `step`",
        params: idParams,
        querystring: {
          type: "object",
          properties: { step: { type: "integer", minimum: 0, description: "Step index" } },
          additionalProperties: false,
        },
        response: responses(200, "Log lines in order", arrayOf("LogLine"), 400, 404),
      },
    },
    async (request, reply) => {
      if (!deps.store.run(request.params.id)) return reply.code(404).send({ error: `no run ${request.params.id}` });
      return deps.store.log(request.params.id, request.query.step);
    },
  );

  app.post<{ Params: { id: number } }>(
    "/runs/:id/cancel",
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
    "/repos",
    {
      schema: {
        summary: "Last known state of each repo",
        response: responses(200, "Repos in config order", arrayOf("Repo")),
      },
    },
    async () => deps.repos.list(deps.config(), deps.runner.locks),
  );

  app.get<{ Querystring: { run?: number; cascade?: string } }>(
    "/events",
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
