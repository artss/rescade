import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import {
  checkResticVersion,
  formatDiagnostic,
  loadConfig,
  Runner,
  Scheduler,
  Store,
  warmUp,
  type Config,
  type RunnerEvent,
} from "@rescade/core";
import { RepoStates } from "./repos.js";
import { buildServer, type DaemonStatus } from "./server.js";
import { allowedHosts, type Settings } from "./settings.js";

export { readSettings, SettingsError, USAGE, type Settings } from "./settings.js";

export interface Daemon {
  app: FastifyInstance;
  /** "host:port" the API listens on (the port is the real one when 0 was asked for). */
  address: string;
  /** Rereads the config; on errors keeps the current one. Returns whether the new config was taken. */
  reload(): Promise<boolean>;
  /** Stops scheduling, interrupts runs in progress and closes the API and the store. */
  stop(): Promise<void>;
}

export interface DaemonOptions {
  /** Environment restic starts from. */
  env: Record<string, string | undefined>;
  /** The built web UI; by default the build of @rescade/web if there is one, `null` for none. */
  webDir?: string | null;
  killGraceMs?: number;
  heartbeatMs?: number;
}

export class StartupError extends Error {}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// the same path from src (tests) and dist
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

/** The build of @rescade/web, when there is one. */
function findWebDir(): string | undefined {
  try {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.resolve("@rescade/web/package.json"))), "dist");
    return existsSync(path.join(dir, "index.html")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads the config, opens the history, warms up the repos (fatal errors on reachable repos stop the start),
 * then starts the runner, the scheduler and the API.
 */
export async function startDaemon(settings: Settings, logger: Logger, options: DaemonOptions): Promise<Daemon> {
  const startedAt = Date.now();
  const loaded = await readConfig(settings.configDir, logger);
  if (!loaded.config) throw new StartupError("the config has errors");
  let config = loaded.config;
  const status: DaemonStatus = { version: VERSION, startedAt, config: { path: settings.configDir, loadedAt: startedAt } };

  await mkdir(settings.dataDir, { recursive: true, mode: 0o700 });
  const store = await Store.open(path.join(settings.dataDir, "rescade.db"));
  let pruneTimer: NodeJS.Timeout | undefined;
  try {
    const interrupted = store.markInterrupted(Date.now());
    if (interrupted > 0) logger.warn({ runs: interrupted }, "marked runs left from the previous start as interrupted");
    const prune = () => {
      try {
        const r = store.prune({ now: Date.now(), historyMs: settings.historyRetentionMs, logMs: settings.logRetentionMs });
        if (r.runs > 0 || r.logLines > 0) logger.info(r, "deleted old history");
      } catch (e) {
        logger.error({ err: e }, "could not delete old history");
      }
    };
    prune();
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS).unref();

    const repos = new RepoStates();
    const resticCtx = {
      binary: settings.restic,
      env: options.env,
      killGraceMs: options.killGraceMs,
      repoCheckTimeoutMs: settings.repoCheckTimeoutMs,
      onRepoChecked: (repo: string, result: Parameters<RepoStates["update"]>[1]) => repos.update(repo, result, Date.now()),
    };
    const restic = await checkResticVersion(settings.restic, options.env);
    if (restic.warning !== undefined) logger.warn({ restic: settings.restic, version: restic.version }, restic.warning);
    else logger.info({ restic: settings.restic, version: restic.version }, "restic found");
    logger.info({ repos: Object.keys(config.repos).length }, "checking repos");
    const warm = await warmUp(config, resticCtx, (repo, line) => logger.info({ repo }, line));
    for (const [repo, r] of warm.results) {
      if (r.ok) {
        logger.info({ repo, initialized: r.initialized }, "repo is ready");
        const stale = r.locks.locks.filter((l) => l.stale);
        if (stale.length > 0) logger.warn({ repo, locks: stale.map((l) => l.id) }, "repo has stale locks");
        if (r.locks.error !== undefined) logger.warn({ repo }, r.locks.error);
      }
      else logger.warn({ repo, problem: r.problem }, r.reason);
    }
    for (const m of warm.mismatches) logger.warn(m);
    if (warm.fatal.length > 0) {
      for (const f of warm.fatal) logger.error(f);
      throw new StartupError("some repos cannot be used");
    }

    const runner = new Runner(config, {
      restic: settings.restic,
      env: options.env,
      killGraceMs: options.killGraceMs,
      repoCheckTimeoutMs: settings.repoCheckTimeoutMs,
      store,
    });
    runner.subscribe((e) => {
      if (e.kind === "repo") repos.update(e.repo, e.result, e.at);
      logEvent(logger, e);
    });

    const scheduler = new Scheduler((cascade) => {
      try {
        runner.trigger(cascade, "schedule");
      } catch (e) {
        logger.error({ cascade, err: e }, "could not start a scheduled run");
      }
    });
    scheduler.update(config.cascades);

    const webDir = options.webDir === undefined ? findWebDir() : (options.webDir ?? undefined);
    if (webDir === undefined) logger.info("the web UI is not built, serving only the API");
    const extraHosts = settings.extraHosts;
    const hosts = extraHosts && new Set<string>();
    const app = await buildServer({
      config: () => config,
      status: () => status,
      runner,
      scheduler,
      store,
      repos,
      restic: { binary: settings.restic, env: options.env, killGraceMs: options.killGraceMs, repoCheckTimeoutMs: settings.repoCheckTimeoutMs },
      token: settings.token,
      allowedHosts: hosts,
      corsOrigins: settings.corsOrigins,
      logger,
      heartbeatMs: options.heartbeatMs,
      webDir,
    });
    const host = settings.host;
    await app.listen({ host, port: settings.port });
    // known only now when port 0 was asked for
    const port = (app.server.address() as { port: number }).port;
    if (extraHosts && hosts) for (const h of allowedHosts(host, port, extraHosts)) hosts.add(h);
    const address = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    logger.info({ address, cascades: Object.keys(config.cascades).length }, "rescade daemon started");

    let stopping: Promise<void> | undefined;
    return {
      app,
      address,
      async reload() {
        const at = Date.now();
        const { config: next, errors } = await readConfig(settings.configDir, logger);
        status.config.lastReload = { at, ok: next !== undefined, errors };
        if (!next) {
          logger.error("config reload failed, keeping the current config");
          return false;
        }
        config = next;
        status.config.loadedAt = at;
        runner.setConfig(next);
        scheduler.update(next.cascades);
        logger.info({ cascades: Object.keys(next.cascades).length }, "config reloaded");
        return true;
      },
      stop() {
        stopping ??= (async () => {
          logger.info("stopping");
          scheduler.stop();
          clearInterval(pruneTimer);
          await runner.stop();
          await app.close();
          store.close();
          logger.info("stopped");
        })();
        return stopping;
      },
    };
  } catch (e) {
    clearInterval(pruneTimer);
    store.close();
    throw e;
  }
}

/** Loads and logs the diagnostics; `config` is absent when there are errors. */
async function readConfig(dir: string, logger: Logger): Promise<{ config?: Config; errors: string[] }> {
  const loaded = await loadConfig({ path: dir });
  const errors: string[] = [];
  for (const d of loaded.diagnostics) {
    const text = formatDiagnostic(d);
    if (d.severity === "error") errors.push(text);
    logger[d.severity === "error" ? "error" : "warn"]({ file: d.file, line: d.line, col: d.col }, text);
  }
  return loaded.ok ? { config: loaded.config, errors } : { errors };
}

function logEvent(logger: Logger, e: RunnerEvent): void {
  switch (e.kind) {
    case "run": {
      const { id: run, cascade, trigger, status, reason } = e.run;
      const fields = { run, cascade, trigger, status, ...(reason === undefined ? {} : { reason }) };
      if (status === "failed" || status === "interrupted") logger.error(fields, `run ${status}`);
      else if (status === "warning" || status === "skipped" || status === "cancelled") logger.warn(fields, `run ${status}`);
      else logger.info(fields, `run ${status}`);
      return;
    }
    case "step":
      if (e.step.status !== "running" && e.step.status !== "queued") {
        const { runId: run, index: step, label, status, reason, exitCode } = e.step;
        logger.info({ run, step, label, status, reason, exitCode }, `step ${status}`);
      }
      return;
    case "log":
      logger.debug({ run: e.runId, step: e.log.step, stream: e.log.stream }, e.log.line);
      return;
    case "repo":
      if (!e.result.ok) logger.warn({ repo: e.repo, problem: e.result.problem }, e.result.reason);
      return;
  }
}
