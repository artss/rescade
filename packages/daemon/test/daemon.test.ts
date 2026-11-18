import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type RunRecord } from "@rescade/core";
import { startDaemon, StartupError, type Daemon, type Settings } from "../src/daemon.js";
import { FAKE_RESTIC, FakeState } from "../../core/test/helpers/fake.js";

const TOKEN = "test-token-0123456789";

let fake: FakeState;
let daemon: Daemon | undefined;
let logs: Array<Record<string, unknown>>;

beforeEach(async () => {
  fake = await FakeState.create();
  logs = [];
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await fake.remove();
});

/** A run step that holds repo b until the file `release` appears in the fake's directory. */
const holdScript =
  "const f = process.argv[1]; console.log('holding'); const t = setInterval(() => require('fs').existsSync(f) && clearInterval(t), 10)";

function configYaml(extra = ""): string {
  const hold = JSON.stringify([process.execPath, "-e", holdScript, path.join(fake.dir, "release")]);
  return `
repos:
  a: { path: /r/a, password: pw-a, retention: { daily: 7 } }
  b: { path: /r/b, password: pw-b, from: a }
cascades:
  daily:
    schedule: "0 3 * * *"
    steps:
      - retain: { repo: a }
  slow:
    steps:
      - run: { command: ${hold}, lock: [b] }
${extra}`;
}

async function start(
  yaml = configYaml(),
  env: Record<string, string> = {},
  extra: Partial<Settings> = {},
  webDir: string | null = null,
): Promise<Daemon> {
  const configFile = path.join(fake.dir, "rescade.yaml");
  await writeFile(configFile, yaml);
  const settings: Settings = {
    host: "127.0.0.1",
    port: 0,
    configDir: configFile,
    dataDir: path.join(fake.dir, "data"),
    restic: FAKE_RESTIC,
    token: TOKEN,
    extraHosts: [],
    corsOrigins: new Set(["https://ui.example"]),
    logLevel: "info",
    ...extra,
  };
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) logs.push(JSON.parse(line));
      done();
    },
  });
  daemon = await startDaemon(settings, pino({ level: "info" }, sink), {
    env: fake.env(env),
    killGraceMs: 500,
    heartbeatMs: 50,
    webDir,
  });
  return daemon;
}

/** Calls the API through Fastify's inject, with the right Host and token unless overridden. */
async function api(method: "GET" | "POST", url: string, headers: Record<string, string> = {}) {
  const port = daemon!.address.split(":").at(-1);
  const res = await daemon!.app.inject({
    method,
    url,
    headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...headers },
  });
  return { status: res.statusCode, body: res.body === "" ? undefined : res.json(), headers: res.headers };
}

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const finished = (r: { body?: RunRecord }) => !["running", "queued"].includes(r.body?.status ?? "running");

describe("startup", () => {
  it("initializes missing repos before serving and reports their state", async () => {
    await start();
    expect(fake.readRepo("/r/b")?.chunker_polynomial).toBe(fake.readRepo("/r/a")?.chunker_polynomial);
    const { body } = await api("GET", "/api/repos");
    expect(body).toMatchObject([
      { name: "a", location: "/r/a", state: "ok" },
      { name: "b", location: "/r/b", from: "a", state: "ok" },
    ]);
    expect(logs.some((l) => l.msg === "rescade daemon started")).toBe(true);
  });

  it("logs the restic version and warns, but starts, when restic is too old", async () => {
    await start();
    expect(logs).toContainEqual(expect.objectContaining({ level: 30, msg: "restic found", version: "0.18.0" }));
    await daemon!.stop();
    daemon = undefined;
    logs = [];

    await start(configYaml(), { FAKE_RESTIC_VERSION: "0.16.4" });
    const warning = logs.find((l) => l.level === 40 && String(l.msg).includes("older than 0.17.0"));
    expect(warning).toMatchObject({ restic: FAKE_RESTIC, version: "0.16.4" });
    expect(logs.some((l) => l.msg === "rescade daemon started")).toBe(true);
  });

  it("refuses to start when a reachable repo has a wrong password", async () => {
    fake.writeRepo("/r/a", "other");
    await expect(start()).rejects.toThrow(StartupError);
    expect(logs.some((l) => l.level === 50 && String(l.msg).includes('wrong password for repo "a"'))).toBe(true);
  });

  it("starts with an unreachable repo and shows it in the state", async () => {
    await start(configYaml(), { FAKE_RESTIC_UNREACHABLE: "/r/b" });
    const { body } = await api("GET", "/api/repos");
    expect(body).toMatchObject([{ name: "a", state: "ok" }, { name: "b", state: "unreachable" }]);
  });

  it("refuses to start with config errors", async () => {
    await expect(start("repos: { a: { path: /r/a } }")).rejects.toThrow("the config has errors");
  });

  it("marks runs left running by the previous start as interrupted", async () => {
    const dataDir = path.join(fake.dir, "data");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir);
    const store = await Store.open(path.join(dataDir, "rescade.db"));
    const left = store.insertRun({ cascade: "daily", trigger: "schedule", status: "running", startedAt: 1 });
    store.close();

    await start();
    const { body } = await api("GET", `/api/runs/${left.id}`);
    expect(body).toMatchObject({ status: "interrupted", reason: "the daemon stopped during the run" });
  });

  it("serves the web UI next to the API when it is built", async () => {
    const webDir = path.join(fake.dir, "web");
    await mkdir(webDir);
    await writeFile(path.join(webDir, "index.html"), "<title>rescade</title>");
    await start(undefined, {}, {}, webDir);
    const port = daemon!.address.split(":").at(-1);
    const res = await daemon!.app.inject({ method: "GET", url: "/runs/1", headers: { host: `127.0.0.1:${port}` } });
    expect(res.body).toContain("<title>rescade</title>");
    expect((await api("GET", "/api/runs")).status).toBe(200);
    await daemon!.stop();

    await start();
    expect(logs.some((l) => l.msg === "the web UI is not built, serving only the API")).toBe(true);
    expect((await api("GET", "/", { authorization: "" })).status).toBe(404);
  });

  it("shows the restore directory in its status only when restore is on", async () => {
    await start(undefined, {}, { restoreDir: "/srv/restore" });
    expect((await api("GET", "/api/status")).body).toMatchObject({ restoreDir: "/srv/restore" });
    await daemon!.stop();

    await start();
    expect((await api("GET", "/api/status")).body).not.toHaveProperty("restoreDir");
  });

  it("deletes old history at start", async () => {
    const dataDir = path.join(fake.dir, "data");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir);
    const store = await Store.open(path.join(dataDir, "rescade.db"));
    const day = 86_400_000;
    const old = store.insertRun({ cascade: "daily", trigger: "schedule", status: "success", startedAt: 1, finishedAt: 2 });
    const latest = store.insertRun({ cascade: "daily", trigger: "schedule", status: "success", startedAt: 3, finishedAt: 4 });
    store.appendLog(latest.id, { step: 0, ts: 3, stream: "stdout", line: "kept" });
    store.close();

    await start(configYaml(), {}, { historyRetentionMs: 10 * day, logRetentionMs: day });
    expect((await api("GET", `/api/runs/${old.id}`)).status).toBe(404);
    expect((await api("GET", `/api/runs/${latest.id}/log`)).body).toMatchObject([{ line: "kept" }]);
    expect(logs.find((l) => l.msg === "deleted old history")).toMatchObject({ runs: 1, logLines: 0 });
  });
});

describe("API access", () => {
  it("needs the token", async () => {
    await start();
    expect((await api("GET", "/api/cascades", { authorization: "" })).status).toBe(401);
    expect((await api("GET", "/api/cascades", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await api("GET", "/api/cascades")).status).toBe(200);
  });

  it("answers only to allowed Host values", async () => {
    await start();
    const res = await api("GET", "/api/cascades", { host: "evil.example" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'host "evil.example" is not allowed' });
  });

  it("answers to any Host without RESCADE_ALLOWED_HOSTS", async () => {
    await start(undefined, {}, { extraHosts: undefined });
    expect((await api("GET", "/api/cascades", { host: "evil.example" })).status).toBe(200);
  });

  it("allows CORS only for configured origins", async () => {
    await start();
    const pre = await api("OPTIONS" as "GET", "/api/cascades", { authorization: "", origin: "https://ui.example" });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://ui.example");
    expect(pre.headers["access-control-allow-headers"]).toContain("Authorization");

    const other = await api("GET", "/api/cascades", { origin: "https://evil.example" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const otherPre = await api("OPTIONS" as "GET", "/api/cascades", { authorization: "", origin: "https://evil.example" });
    expect(otherPre.status).toBe(401);
  });
});

describe("runs over the API", () => {
  it("runs a cascade and shows the run, its steps and log", async () => {
    await start();
    const started = await api("POST", "/api/cascades/daily/run");
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ cascade: "daily", trigger: "manual", status: "running" });

    const run = await until(() => api("GET", `/api/runs/${started.body.id}`), finished, "the run to finish");
    expect(run.body).toMatchObject({ status: "success", steps: [{ label: "retain a", status: "success" }] });
    const log = await api("GET", `/api/runs/${started.body.id}/log?step=0`);
    expect(log.body.map((l: { line: string }) => l.line)).toContain("Applying Policy: keep 7 daily snapshots");
    const all = (await api("GET", `/api/runs/${started.body.id}/log`)).body as Array<{ id: number }>;
    const rest = await api("GET", `/api/runs/${started.body.id}/log?after=${all[0]!.id}`);
    expect(rest.body).toEqual(all.slice(1));

    const cascades = await api("GET", "/api/cascades");
    const daily = cascades.body.find((c: { name: string }) => c.name === "daily");
    expect(daily).toMatchObject({ schedule: ["0 3 * * *"], steps: [{ type: "retain", label: "retain a" }], active: null });
    expect(daily.lastRun.id).toBe(started.body.id);
    expect(daily.nextRun).toBeGreaterThan(Date.now());

    expect((await api("GET", "/api/runs?cascade=daily&limit=5")).body.map((r: RunRecord) => r.id)).toEqual([started.body.id]);
    expect((await api("POST", `/api/runs/${started.body.id}/cancel`)).status).toBe(409);
  });

  it("validates ids and reports unknown things", async () => {
    await start();
    expect((await api("POST", "/api/cascades/nope/run")).status).toBe(404);
    expect((await api("GET", "/api/runs/999")).status).toBe(404);
    expect((await api("GET", "/api/runs/abc")).status).toBe(400);
    expect((await api("GET", "/api/runs?limit=0")).status).toBe(400);
    expect((await api("POST", "/api/runs/999/cancel")).status).toBe(404);
    expect((await api("GET", "/api/nothing")).status).toBe(404);
  });

  it("cancels a run and shows who holds a repo", async () => {
    await start();
    const started = await api("POST", "/api/cascades/slow/run");
    await until(() => api("GET", "/api/repos"), (r) => r.body[1]?.lockedBy !== undefined, "slow to take repo b");
    expect((await api("GET", "/api/repos")).body[1].lockedBy).toEqual({ runId: started.body.id, cascade: "slow" });
    expect((await api("POST", "/api/cascades/slow/run")).body).toMatchObject({ status: "skipped" });

    expect((await api("POST", `/api/runs/${started.body.id}/cancel`)).status).toBe(202);
    const run = await until(() => api("GET", `/api/runs/${started.body.id}`), finished, "the run to stop");
    expect(run.body.status).toBe("cancelled");
  });

  it("lists snapshots of a repo held by a run, without waiting for it", async () => {
    await start();
    const started = await api("POST", "/api/cascades/slow/run");
    await until(() => api("GET", "/api/repos"), (r) => r.body[1]?.lockedBy !== undefined, "slow to take repo b");
    expect(await api("GET", "/api/repos/b/snapshots")).toMatchObject({ status: 200, body: [] });
    await api("POST", `/api/runs/${started.body.id}/cancel`);
  });

  it("stops restic when the client of a snapshot query goes away", async () => {
    await start(configYaml(), { FAKE_RESTIC_HANG: "snapshots" });
    const port = daemon!.address.split(":").at(-1);
    const ac = new AbortController();
    const res = fetch(`http://127.0.0.1:${port}/api/repos/a/snapshots`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    }).catch(() => undefined);
    await until(async () => fake.calls().some((c) => c.cmd === "snapshots"), (v) => v, "restic snapshots to start");
    ac.abort();
    await res;
    await until(async () => fake.sigtermReceived, (v) => v, "restic to get SIGTERM");
  });

  it("streams events of a cascade over SSE", async () => {
    await start();
    const ac = new AbortController();
    const res = await fetch(`http://${daemon!.address}/api/events?cascade=daily`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await api("POST", "/api/cascades/slow/run");
    await api("POST", "/api/cascades/daily/run");

    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes('"status":"success"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
    }
    ac.abort();
    const events = text
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => JSON.parse(block.split("\ndata: ")[1]!));
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(["run", "step", "log"]));
    // events of the other cascade are left out
    expect(events.every((e) => e.kind !== "run" || e.run.cascade === "daily")).toBe(true);
    await writeFile(path.join(fake.dir, "release"), "");
  });
});

describe("reload and stop", () => {
  it("takes a new config on reload and keeps the old one when the new one is broken", async () => {
    await start();
    const configFile = path.join(fake.dir, "rescade.yaml");
    const before = (await api("GET", "/api/status")).body;
    expect(before).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      startedAt: expect.any(Number),
      config: { path: configFile, loadedAt: before.startedAt },
    });

    await writeFile(configFile, configYaml("  weekly:\n    steps:\n      - check: { repo: a }\n"));
    expect(await daemon!.reload()).toBe(true);
    expect((await api("GET", "/api/cascades")).body.map((c: { name: string }) => c.name)).toEqual(["daily", "slow", "weekly"]);
    const reloaded = (await api("GET", "/api/status")).body;
    expect(reloaded.config.lastReload).toEqual({ at: reloaded.config.loadedAt, ok: true, errors: [] });

    await writeFile(configFile, "cascades: [");
    expect(await daemon!.reload()).toBe(false);
    expect((await api("GET", "/api/cascades")).body).toHaveLength(3);
    expect(logs.some((l) => l.msg === "config reload failed, keeping the current config")).toBe(true);
    const failed = (await api("GET", "/api/status")).body;
    expect(failed.config.loadedAt).toBe(reloaded.config.loadedAt);
    expect(failed.config.lastReload).toMatchObject({ ok: false, errors: [expect.stringContaining("rescade.yaml:1:")] });
  });

  it("interrupts runs in progress when stopping", async () => {
    await start();
    const started = await api("POST", "/api/cascades/slow/run");
    await until(() => api("GET", "/api/repos"), (r) => r.body[1]?.lockedBy !== undefined, "slow to take repo b");
    const d = daemon!;
    daemon = undefined;
    await d.stop();

    const store = await Store.open(path.join(fake.dir, "data", "rescade.db"));
    expect(store.run(started.body.id)).toMatchObject({
      status: "interrupted",
      steps: [{ status: "interrupted" }],
    });
    store.close();
  });
});
