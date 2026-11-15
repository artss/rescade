import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config, type LogRecord, type RunRecord, type StepRecord } from "@rescade/core";
import { RepoStates } from "../src/repos.js";
import { buildServer, OPENAPI_PATH, type ServerDeps } from "../src/server.js";

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
const log: LogRecord = { step: 0, ts: 1500, stream: "stderr", line: "Fatal: oops" };

let dir: string;
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

  const deps = {
    config: () => config,
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
    ["GET", "/cascades", 200],
    ["POST", "/cascades/daily/run", 202],
    ["GET", "/runs", 200],
    ["GET", "/runs/7", 200],
    ["GET", "/runs/7/log", 200],
    ["POST", "/runs/7/cancel", 202],
    ["GET", "/repos", 200],
  ] as const)("%s %s keeps every field", async (method, url, status) => {
    const res = await call(method, url);
    expect(res.status).toBe(status);
    expect(serialized).toBeDefined();
    expect(res.body).toEqual(JSON.parse(JSON.stringify(serialized)));
  });

  it("keeps nested values of a backup summary and the repo state", async () => {
    expect((await call("GET", "/runs/7")).body.steps[0].summary).toEqual(step.summary);
    expect((await call("GET", "/repos")).body).toMatchObject([
      { location: "rest:https://user:***@host/a", locks: { count: 11, error: "partly read" } },
      { state: "unreachable", lockedBy: { runId: 7 } },
    ]);
  });
});

describe("OpenAPI document", () => {
  it("is served without the token but behind the Host check", async () => {
    const res = await call("GET", OPENAPI_PATH, { authorization: "" });
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect((await call("GET", OPENAPI_PATH, { authorization: "", host: "evil.example" })).status).toBe(403);
    expect((await call("GET", "/runs", { authorization: "" })).status).toBe(401);
  });

  it("describes every route with its responses", async () => {
    const spec = (await call("GET", OPENAPI_PATH)).body;
    const operations = Object.entries(spec.paths as Record<string, Record<string, { responses: object }>>).flatMap(
      ([p, methods]) =>
        Object.entries(methods).map(([m, op]) => ({ op: `${m.toUpperCase()} ${p}`, codes: Object.keys(op.responses) })),
    );
    expect(operations.map((o) => o.op).sort()).toEqual([
      "GET /cascades",
      "GET /events",
      "GET /repos",
      "GET /runs",
      "GET /runs/{id}",
      "GET /runs/{id}/log",
      "POST /cascades/{name}/run",
      "POST /runs/{id}/cancel",
    ]);
    for (const { codes } of operations) {
      expect(codes.some((c) => c.startsWith("2"))).toBe(true);
      expect(codes).toEqual(expect.arrayContaining(["401", "403"]));
    }
    expect(spec.paths["/runs/{id}"].get.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/RunWithSteps",
    });
  });

  // regenerate with `pnpm vitest run -u`
  it("matches docs/openapi.json", async () => {
    const spec = (await call("GET", OPENAPI_PATH)).body;
    await expect(`${JSON.stringify(spec, null, 2)}\n`).toMatchFileSnapshot("../../../docs/openapi.json");
  });
});
