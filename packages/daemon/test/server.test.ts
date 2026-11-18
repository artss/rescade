import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RUN_TIMEOUT_MS, loadConfig, type Config, type LogRecord, type RunRecord, type StepRecord } from "@rescade/core";
import { RepoStates } from "../src/repos.js";
import { FAKE_RESTIC, FakeState } from "../../core/test/helpers/fake.js";
import { buildServer, DOCS_PATH, HEALTH_PATH, OPENAPI_PATH, type DaemonStatus, type ServerDeps } from "../src/server.js";

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
const restoreRun: RunRecord = {
  id: 8,
  restore: { repo: "a", snapshot: "c8b33f97", paths: ["/home/f"], target: "/restore/c8b33f97" },
  trigger: "manual",
  status: "running",
  startedAt: 3000,
};
const rerunRun: RunRecord = { ...run, id: 9, rerunOf: 7, fromStep: 0, status: "running", startedAt: 4000 };
delete rerunRun.reason;
delete rerunRun.finishedAt;
const restoreRequests: unknown[] = [];
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
  repo: "a",
};
const SNAP = "5".repeat(64);
const snapshot = {
  time: "2026-11-01T10:00:00Z",
  paths: ["/home"],
  hostname: "box",
  username: "root",
  tags: ["auto"],
  parent: "4".repeat(64),
  summary: { total_bytes_processed: 5000, total_files_processed: 3, data_added: 1200 },
  id: SNAP,
  short_id: SNAP.slice(0, 8),
};
const node = { name: "f", type: "file", path: "/home/f", size: 3, permissions: "-rw-r--r--", mtime: "2026-11-01T10:00:00Z", uid: 0, gid: 0 };
const log: LogRecord = { id: 3, step: 0, ts: 1500, stream: "stderr", line: "Fatal: oops" };
const status: DaemonStatus = {
  version: "1.2.3",
  startedAt: 500,
  config: { path: "/etc/rescade/config", loadedAt: 600, lastReload: { at: 700, ok: false, errors: ["a.yaml:1:1: error: x"] } },
  restoreDir: "/restore",
};

let dir: string;
let fake: FakeState;
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
  a: { path: "rest:https://user:secret@host/a", password: pw, retention: { daily: 7, within: 1m } }
  b: { path: /r/b, password: pw, from: a, group: offsite }
sets:
  home: { include: [/home] }
  docs:
    include: [/srv/docs, /srv/wiki]
    exclude: ["**/.cache"]
    tags: [docs, srv]
    one-file-system: true
    exclude-caches: true
cascades:
  daily:
    group: nightly
    description: Home to a
    schedule: "0 3 * * *"
    timezone: Europe/Berlin
    on-busy: wait
    wait-timeout: 10m
    steps:
      - backup: { set: home, repo: a }
  full:
    steps:
      - name: dump
        run: { command: [/bin/dump, --all], cwd: /tmp, env: { PGPASSWORD: hunter2 }, timeout: 5m, lock: [a] }
      - run: { command: "echo done", shell: true }
      - backup: { set: docs, repo: b, tags: [srv, nightly] }
      - retain: { repo: a }
      - prune: { repo: a, max-unused: 5% }
      - check: { repo: a, read-data-subset: 1/10 }
      - copy: { from: a, to: b }
`,
  );
  const loaded = await loadConfig({ path: file });
  if (!loaded.ok) throw new Error("test config has errors");
  const config: Config = loaded.config;
  fake = await FakeState.create();
  fake.writeRepo("rest:https://user:secret@host/a", "pw");
  fake.writeSnapshots("rest:https://user:secret@host/a", [snapshot], { [SNAP]: [{ ...node, path: "/home", name: "home", type: "dir" }, node] });

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
      rerun: () => rerunRun,
      restore: (request: unknown) => {
        restoreRequests.push(request);
        return restoreRun;
      },
      restoreDir: "/restore",
      cancel: () => true,
      isStopping: false,
      locks: { holder: (repo: string) => (repo === "b" ? { runId: 7, cascade: "daily" } : undefined) },
      subscribe: () => () => {},
    },
    scheduler: { nextRun: () => new Date(5000) },
    store: { runs: () => [run], countRuns: () => 1, run: () => ({ ...run, steps: [step] }), log: () => [log] },
    repos,
    restic: { binary: FAKE_RESTIC, env: fake.env() },
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
  await fake.remove();
});

async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = {}, payload?: object) {
  serialized = undefined;
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${TOKEN}`, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
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
    ["POST", "/api/runs/7/rerun", 202],
    ["GET", "/api/repos", 200],
    ["GET", "/api/summary", 200],
    ["GET", "/api/repos/a/snapshots", 200],
    ["GET", `/api/repos/a/snapshots/${SNAP}/ls?path=/home`, 200],
    ["POST", "/api/repos/a/snapshots/c8b33f97/restore", 202],
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
      { state: "unreachable", lockedBy: { runId: 7 }, group: "offsite" },
    ]);
    expect((await call("GET", "/api/repos")).body[0].group).toBeUndefined();
    const groups = (await call("GET", "/api/cascades")).body.map((c: { group: string | null }) => c.group);
    expect(groups).toEqual(["nightly", null]);
  });

  it("shows the settings of every step, env without values", async () => {
    const full = (await call("GET", "/api/cascades")).body.find((c: { name: string }) => c.name === "full");
    expect(full.steps).toEqual([
      {
        type: "run",
        label: "dump",
        name: "dump",
        shell: false,
        argv: ["/bin/dump", "--all"],
        cwd: "/tmp",
        env: ["PGPASSWORD"],
        timeoutMs: 300_000,
        lock: ["a"],
      },
      {
        type: "run",
        label: "run echo done",
        name: null,
        shell: true,
        command: "echo done",
        cwd: null,
        env: [],
        timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
        lock: [],
      },
      {
        type: "backup",
        label: "backup docs -> b",
        name: null,
        set: "docs",
        repo: "b",
        include: ["/srv/docs", "/srv/wiki"],
        exclude: ["**/.cache"],
        tags: ["docs", "srv", "nightly"],
        oneFileSystem: true,
        excludeCaches: true,
      },
      { type: "retain", label: "retain a", name: null, repo: "a", retention: { daily: 7, within: "1m" } },
      { type: "prune", label: "prune a", name: null, repo: "a", maxUnused: "5%" },
      { type: "check", label: "check a", name: null, repo: "a", readDataSubset: "1/10" },
      { type: "copy", label: "copy a -> b", name: null, from: "a", to: "b" },
    ]);
    expect(JSON.stringify(full)).not.toContain("hunter2");
  });
});

describe("summary", () => {
  it("counts cascades by their latest finished run and finds the nearest runs", async () => {
    const r = (id: number, status: RunRecord["status"], finishedAt?: number): RunRecord => {
      const { finishedAt: _, ...rest } = run;
      return { ...rest, id, status, startedAt: id * 100, ...(finishedAt !== undefined && { finishedAt }) };
    };
    const history: Record<string, RunRecord[]> = {
      // newest first: in progress and skipped runs have no outcome
      daily: [r(9, "running"), r(8, "skipped", 800), r(5, "success", 3000), r(4, "failed", 2500)],
      // a cancelled run leaves the outcome before it; an interrupted one counts as failed
      full: [r(7, "cancelled", 700), r(6, "interrupted")],
    };
    const summaryApp = await buildServer({
      ...deps,
      runner: { ...deps.runner, running: () => [r(9, "running"), r(10, "queued")] },
      scheduler: { nextRun: (name: string) => (name === "daily" ? new Date(9000) : undefined) },
      store: { ...deps.store, runs: ({ cascade }: { cascade: string }) => history[cascade] ?? [] },
    } as unknown as ServerDeps);
    const res = await summaryApp.inject({ url: "/api/summary", headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
    await summaryApp.close();
    expect(res.json()).toEqual({
      cascades: 2,
      running: 1,
      queued: 1,
      success: 1,
      warning: 0,
      failed: 1,
      lastRunAt: 3000,
      nextRunAt: 9000,
      repos: 2,
      repoProblems: 1,
    });
  });

  it("has no times before the first run and without schedules", async () => {
    const summaryApp = await buildServer({
      ...deps,
      scheduler: { nextRun: () => undefined },
      store: { ...deps.store, runs: () => [] },
    } as unknown as ServerDeps);
    const res = await summaryApp.inject({ url: "/api/summary", headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
    await summaryApp.close();
    expect(res.json()).toMatchObject({ success: 0, failed: 0, lastRunAt: null, nextRunAt: null });
  });
});

describe("snapshots", () => {
  it("lists the snapshots and a directory of one", async () => {
    expect((await call("GET", "/api/repos/a/snapshots")).body).toMatchObject([{ id: SNAP, size: 5000, tags: ["auto"] }]);
    expect((await call("GET", `/api/repos/a/snapshots/${SNAP.slice(0, 8)}/ls?path=/home/`)).body).toMatchObject({
      path: "/home",
      entries: [{ name: "f", size: 3 }],
      truncated: false,
    });
    expect((await call("GET", `/api/repos/a/snapshots/${SNAP}/ls`)).body.entries).toMatchObject([{ path: "/home" }]);
  });

  it("answers what went wrong with a status of its own", async () => {
    expect(await call("GET", "/api/repos/nope/snapshots")).toEqual({ status: 404, body: { error: 'unknown repo "nope"' } });
    expect((await call("GET", `/api/repos/a/snapshots/${SNAP}/ls?path=/nope`)).status).toBe(404);
    expect((await call("GET", "/api/repos/a/snapshots/abcdef12/ls")).status).toBe(404);
    expect((await call("GET", "/api/repos/a/snapshots/--help/ls")).status).toBe(400);
    expect((await call("GET", `/api/repos/a/snapshots/${SNAP}/ls?path=home`)).status).toBe(400);
    // b has no repo in the fake: restic exits with code 10
    expect((await call("GET", "/api/repos/b/snapshots")).status).toBe(502);

    const env = deps.restic.env;
    try {
      deps.restic.env = fake.env({ FAKE_RESTIC_EXIT_SNAPSHOTS: "11" });
      expect(await call("GET", "/api/repos/a/snapshots")).toEqual({ status: 409, body: { error: "fake failure in snapshots" } });
      deps.restic.env = fake.env({ FAKE_RESTIC_HANG: "snapshots" });
      deps.restic.repoCheckTimeoutMs = 200;
      expect((await call("GET", "/api/repos/a/snapshots")).status).toBe(504);
    } finally {
      deps.restic.env = env;
      delete deps.restic.repoCheckTimeoutMs;
    }
  });
});

describe("restore", () => {
  const url = "/api/repos/a/snapshots/c8b33f97/restore";
  const post = (body?: object, to = url) => call("POST", to, {}, body);

  it("starts a restore of the whole snapshot or of some paths", async () => {
    restoreRequests.length = 0;
    expect(await post()).toEqual({ status: 202, body: restoreRun });
    expect(await post({})).toMatchObject({ status: 202 });
    expect(await post({ paths: ["/home/f", "/home/a b[1]"] })).toMatchObject({ status: 202 });
    expect(restoreRequests).toEqual([
      { repo: "a", snapshot: "c8b33f97", paths: [] },
      { repo: "a", snapshot: "c8b33f97", paths: [] },
      { repo: "a", snapshot: "c8b33f97", paths: ["/home/f", "/home/a b[1]"] },
    ]);
  });

  it("rejects what it cannot restore", async () => {
    restoreRequests.length = 0;
    expect((await post({ paths: ["home/f"] })).status).toBe(400);
    expect((await post({ paths: ["/home/\u0000x"] })).status).toBe(400);
    expect((await post({ paths: Array.from({ length: 1001 }, (_, i) => `/f${i}`) })).status).toBe(400);
    expect((await post({}, "/api/repos/a/snapshots/--help/restore")).status).toBe(400);
    expect(await post({}, "/api/repos/nope/snapshots/c8b33f97/restore")).toEqual({
      status: 404,
      body: { error: 'unknown repo "nope"' },
    });
    expect(restoreRequests).toEqual([]);

    // Fastify drops unknown fields: the target is the daemon's to choose
    expect((await post({ target: "/elsewhere" })).status).toBe(202);
    expect(restoreRequests).toEqual([{ repo: "a", snapshot: "c8b33f97", paths: [] }]);
  });

  it("answers 409 when the daemon has no restore directory", async () => {
    const off = await buildServer({ ...deps, runner: { ...deps.runner, restoreDir: undefined } as unknown as ServerDeps["runner"] });
    try {
      const res = await off.inject({ method: "POST", url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/--restore-dir or RESCADE_RESTORE_DIR/);
    } finally {
      await off.close();
    }
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

  it("answers the health check without the token but behind the Host check", async () => {
    const res = await call("GET", HEALTH_PATH, { authorization: "" });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect((await call("GET", HEALTH_PATH, { authorization: "", host: "evil.example" })).status).toBe(403);
    const spec = (await call("GET", OPENAPI_PATH)).body;
    expect(spec.paths[HEALTH_PATH].get.security).toEqual([]);
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
      "GET /api/health",
      "GET /api/repos",
      "GET /api/repos/{name}/snapshots",
      "GET /api/repos/{name}/snapshots/{id}/ls",
      "GET /api/runs",
      "GET /api/runs/{id}",
      "GET /api/runs/{id}/log",
      "GET /api/status",
      "GET /api/summary",
      "POST /api/cascades/{name}/run",
      "POST /api/repos/{name}/snapshots/{id}/restore",
      "POST /api/runs/{id}/cancel",
      "POST /api/runs/{id}/rerun",
    ]);
    for (const { op, codes } of operations) {
      expect(codes.some((c) => c.startsWith("2"))).toBe(true);
      expect(codes).toEqual(expect.arrayContaining(op === `GET ${HEALTH_PATH}` ? ["403"] : ["401", "403"]));
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
