import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describeStep, type Config, type Runner, type RunnerEvent, type Scheduler, type Store } from "@rescade/core";
import type { RepoStates } from "./repos.js";

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

/** The HTTP API. Every request needs the Host check and the bearer token, except CORS preflight. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: true }),
    // SSE connections stay open; close them with the server
    forceCloseConnections: true,
  });

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

  app.get("/cascades", async () => {
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
  });

  app.post<{ Params: { name: string } }>("/cascades/:name/run", async (request, reply) => {
    const { name } = request.params;
    if (!deps.config().cascades[name]) return reply.code(404).send({ error: `unknown cascade "${name}"` });
    if (deps.runner.isStopping) return reply.code(503).send({ error: "the daemon is stopping" });
    const run = deps.runner.trigger(name, "manual");
    request.log.info({ run: run.id, cascade: name, status: run.status }, "manual run requested");
    return reply.code(202).send(run);
  });

  app.get<{ Querystring: { cascade?: string; limit?: number; before?: number } }>(
    "/runs",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { cascade: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 }, before: id },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { cascade, limit, before } = request.query;
      return deps.store.runs({ cascade, limit, beforeId: before });
    },
  );

  app.get<{ Params: { id: number } }>("/runs/:id", { schema: { params: idParams } }, async (request, reply) => {
    const run = deps.store.run(request.params.id);
    return run ?? reply.code(404).send({ error: `no run ${request.params.id}` });
  });

  app.get<{ Params: { id: number }; Querystring: { step?: number } }>(
    "/runs/:id/log",
    {
      schema: {
        params: idParams,
        querystring: {
          type: "object",
          properties: { step: { type: "integer", minimum: 0 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!deps.store.run(request.params.id)) return reply.code(404).send({ error: `no run ${request.params.id}` });
      return deps.store.log(request.params.id, request.query.step);
    },
  );

  app.post<{ Params: { id: number } }>("/runs/:id/cancel", { schema: { params: idParams } }, async (request, reply) => {
    const { id: runId } = request.params;
    if (deps.runner.cancel(runId)) {
      request.log.info({ run: runId }, "cancel requested");
      return reply.code(202).send({ cancelling: true });
    }
    const run = deps.store.run(runId);
    if (!run) return reply.code(404).send({ error: `no run ${runId}` });
    return reply.code(409).send({ error: `run ${runId} is not in progress (${run.status})` });
  });

  app.get("/repos", async () => deps.repos.list(deps.config(), deps.runner.locks));

  app.get<{ Querystring: { run?: number; cascade?: string } }>(
    "/events",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { run: id, cascade: { type: "string" } },
          additionalProperties: false,
        },
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
    const runId = e.kind === "run" ? e.run.id : e.kind === "step" ? e.step.runId : e.kind === "log" ? e.runId : undefined;
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
