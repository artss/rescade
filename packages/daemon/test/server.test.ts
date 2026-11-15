import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config, type LogRecord, type RunRecord, type StepRecord } from "@rescade/core";
import { RepoStates } from "../src/repos.js";
import { buildServer, DOCS_PATH, OPENAPI_PATH, type DaemonStatus, type ServerDeps } from "../src/server.js";

const TOKEN = "test-token-0123456789";
const HOST = "localhost:8765";

// every optional field filled in, so a field missing from a response schema shows up as dropped
const run: RunRecord = {
  id: 7,
  cascade: "daily",
  trigger: "manual",
  status: "failed",
  reason: "step 0 failed",
  startedAt: 1000,
  finishedAt: 2000,
};
const step: StepRecord = {
  runId: 7,
  index: 0,
  type: "backup",
  label: "backup home -> a",
  status: "failed",
  exitCode: 1,
  startedAt: 1000,
  durationMs: 900,
  reason: "restic exited with code 1",
  stderrTail: ["Fatal: oops"],
  summary: { files_new: 3, nested: { list: [1, 2] } },
};
const log: LogRecord = { id: 3, step: 0, ts: 1500, stream: "stderr", line: "Fatal: oops" };
const status: DaemonStatus = {
  version: "1.2.3",
  startedAt: 500,
  config: { path: "/etc/rescade/config", loadedAt: 600, lastReload: { at: 700, ok: false, errors: ["a.yaml:1:1: error: x"] } },
};

let dir: string;
let deps: ServerDeps;
let app: FastifyInstance;
let serialized: unknown;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rescade-server-"));
  const file = path.join(dir, "rescade.yaml");
  await writeFile(
    file,
    `
repos:
  a: { path: "rest:https://user:secret@host/a", password: pw }
  b: { path: /r/b, password: pw, from: a }
sets:
  home: { include: [/home] }
cascades:
  daily:
    description: Home to a
    schedule: "0 3 * * *"
    timezone: Europe/Berlin
    on-busy: wait
    wait-timeout: 10m
    steps:
      - backup: { set: home, repo: a }
`,
  );
  const loaded = await loadConfig({ path: file });
  if (!loaded.ok) throw new Error("test config has errors");
  const config: Config = loaded.config;

  const repos = new RepoStates();
  const lock = { id: "f".repeat(64), time: 1200, exclusive: true, hostname: "h", username: "u", pid: 42, stale: true };
  repos.update(
    "a",
    {
      ok: true,
      config: { id: "abc", chunkerPolynomial: "3f" },
      initialized: false,
      locks: { count: 11, locks: [lock], error: "partly read" },
    },
    1100,
  );
  repos.update("b", { ok: false, problem: "unreachable", reason: "no route to host" }, 1100);

  deps = {
    config: () => config,
    status: () => status,
    runner: {
      running: () => [run],
      trigger: () => run,
      cancel: () => true,
      isStopping: false,
      locks: { holder: (repo: string) => (repo === "b" ? { runId: 7, cascade: "daily" } : undefined) },
      subscribe: () => () => {},
    },
    scheduler: { nextRun: () => new Date(5000) },
    store: { runs: () => [run], run: () => ({ ...run, steps: [step] }), log: () => [log] },
    repos,
    token: TOKEN,
    allowedHosts: new Set([HOST]),
    corsOrigins: new Set<string>(),
    logger: pino({ level: "silent" }),
  } as unknown as ServerDeps;

  app = await buildServer(deps);
  app.addHook("preSerialization", async (_request, _reply, payload) => {
    serialized = payload;
    return payload;
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = {}) {
  serialized = undefined;
  const res = await app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}`, ...headers } });
  return { status: res.statusCode, body: res.json() };
}

describe("response schemas", () => {
  it.each([
    ["GET", "/api/status", 200],
    ["GET", "/api/cascades", 200],
    ["POST", "/api/cascades/daily/run", 202],
    ["GET", "/api/runs", 200],
    ["GET", "/api/runs/7", 200],
    ["GET", "/api/runs/7/log", 200],
    ["POST", "/api/runs/7/cancel", 202],
    ["GET", "/api/repos", 200],
  ] as const)("%s %s keeps every field", async (method, url, status) => {
    const res = await call(method, url);
    expect(res.status).toBe(status);
    expect(serialized).toBeDefined();
    expect(res.body).toEqual(JSON.parse(JSON.stringify(serialized)));
  });

  it("keeps nested values of a backup summary and the repo state", async () => {
    expect((await call("GET", "/api/runs/7")).body.steps[0].summary).toEqual(step.summary);
    expect((await call("GET", "/api/repos")).body).toMatchObject([
      { location: "rest:https://user:***@host/a", locks: { count: 11, error: "partly read" } },
      { state: "unreachable", lockedBy: { runId: 7 } },
    ]);
  });
});

describe("web UI", () => {
  let web: FastifyInstance;
  beforeAll(async () => {
    const webDir = path.join(dir, "web");
    await mkdir(path.join(webDir, "assets"), { recursive: true });
    await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>rescade</title>");
    await writeFile(path.join(webDir, "assets", "app-1a2b.js"), "console.log(1)");
    web = await buildServer({ ...deps, webDir });
  });
  afterAll(() => web.close());

  const get = (url: string, headers: Record<string, string> = {}) =>
    web.inject({ method: "GET", url, headers: { host: HOST, ...headers } });

  it("serves the page without the token, also for paths routed in the browser", async () => {
    for (const url of ["/", "/runs/7", "/cascades/daily?tab=log"]) {
      const res = await get(url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("<title>rescade</title>");
    }
    expect((await get("/", { host: "evil.example" })).statusCode).toBe(403);
  });

  it("serves hashed assets as immutable and does not answer a missing file with the page", async () => {
    const asset = await get("/assets/app-1a2b.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await get("/assets/missing.js")).statusCode).toBe(404);
  });

  it("keeps the API behind the token and its unknown paths as JSON errors", async () => {
    expect((await get("/api/runs")).statusCode).toBe(401);
    expect((await get("/api/nothing")).statusCode).toBe(401);
    const missing = await get("/api/nothing", { authorization: `Bearer ${TOKEN}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "no route GET /api/nothing" });
    expect((await get("/api/runs", { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(200);
    for (const url of ["/%61pi/runs", "/API/runs"]) {
      const res = await get(url);
      expect([200, 401, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain('"cascade"');
    }
    expect((await get(`${DOCS_PATH}/`)).statusCode).toBe(200);
  });

  it("is absent without a web directory", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: { host: HOST } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no route GET /" });
  });
});

describe("OpenAPI document", () => {
  it("is served without the token but behind the Host check", async () => {
    const res = await call("GET", OPENAPI_PATH, { authorization: "" });
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect((await call("GET", OPENAPI_PATH, { authorization: "", host: "evil.example" })).status).toBe(403);
    expect((await call("GET", "/api/runs", { authorization: "" })).status).toBe(401);
  });

  it("shows Swagger UI without the token but behind the Host check", async () => {
    const get = (url: string, host = HOST) => app.inject({ method: "GET", url, headers: { host } });
    const page = await get(`${DOCS_PATH}/`);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    const initializer = await get(`${DOCS_PATH}/static/swagger-initializer.js`);
    expect(initializer.statusCode).toBe(200);
    expect((await get(`${DOCS_PATH}/json`)).json().paths["/api/runs"]).toBeDefined();
    expect((await get(`${DOCS_PATH}/`, "evil.example")).statusCode).toBe(403);
  });

  it("describes every route with its responses", async () => {
    const spec = (await call("GET", OPENAPI_PATH)).body;
    const operations = Object.entries(spec.paths as Record<string, Record<string, { responses: object }>>).flatMap(
      ([p, methods]) =>
        Object.entries(methods).map(([m, op]) => ({ op: `${m.toUpperCase()} ${p}`, codes: Object.keys(op.responses) })),
    );
    expect(operations.map((o) => o.op).sort()).toEqual([
      "GET /api/cascades",
      "GET /api/events",
      "GET /api/repos",
      "GET /api/runs",
      "GET /api/runs/{id}",
      "GET /api/runs/{id}/log",
      "GET /api/status",
      "POST /api/cascades/{name}/run",
      "POST /api/runs/{id}/cancel",
    ]);
    for (const { codes } of operations) {
      expect(codes.some((c) => c.startsWith("2"))).toBe(true);
      expect(codes).toEqual(expect.arrayContaining(["401", "403"]));
    }
    expect(spec.paths["/api/runs/{id}"].get.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/RunWithSteps",
    });
  });

  // regenerate with `pnpm vitest run -u`
  it("matches docs/openapi.json", async () => {
    const spec = (await call("GET", OPENAPI_PATH)).body;
    await expect(`${JSON.stringify(spec, null, 2)}\n`).toMatchFileSnapshot("../../../docs/openapi.json");
  });
});
