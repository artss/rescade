import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import {
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
import { buildServer } from "./server.js";
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
  killGraceMs?: number;
  heartbeatMs?: number;
}

export class StartupError extends Error {}

/**
 * Loads the config, opens the history, warms up the repos (fatal errors on reachable repos stop the start),
 * then starts the runner, the scheduler and the API.
 */
export async function startDaemon(settings: Settings, logger: Logger, options: DaemonOptions): Promise<Daemon> {
  let config = await readConfig(settings.configDir, logger);
  if (!config) throw new StartupError("the config has errors");

  await mkdir(settings.dataDir, { recursive: true, mode: 0o700 });
  const store = await Store.open(path.join(settings.dataDir, "rescade.db"));
  try {
    const interrupted = store.markInterrupted(Date.now());
    if (interrupted > 0) logger.warn({ runs: interrupted }, "marked runs left from the previous start as interrupted");

    const repos = new RepoStates();
    const resticCtx = {
      binary: settings.restic,
      env: options.env,
      killGraceMs: options.killGraceMs,
      repoCheckTimeoutMs: settings.repoCheckTimeoutMs,
      onRepoChecked: (repo: string, result: Parameters<RepoStates["update"]>[1]) => repos.update(repo, result, Date.now()),
    };
    logger.info({ repos: Object.keys(config.repos).length }, "checking repos");
    const warm = await warmUp(config, resticCtx, (repo, line) => logger.info({ repo }, line));
    for (const [repo, r] of warm.results) {
      if (r.ok) logger.info({ repo, initialized: r.initialized }, "repo is ready");
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

    const hosts = new Set<string>();
    const app = buildServer({
      config: () => config!,
      runner,
      scheduler,
      store,
      repos,
      token: settings.token,
      allowedHosts: hosts,
      corsOrigins: settings.corsOrigins,
      logger,
      heartbeatMs: options.heartbeatMs,
    });
    const host = settings.host;
    await app.listen({ host, port: settings.port });
    // known only now when port 0 was asked for
    const port = (app.server.address() as { port: number }).port;
    for (const h of allowedHosts(host, port, settings.extraHosts)) hosts.add(h);
    const address = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    logger.info({ address, cascades: Object.keys(config.cascades).length }, "rescade daemon started");

    let stopping: Promise<void> | undefined;
    return {
      app,
      address,
      async reload() {
        const next = await readConfig(settings.configDir, logger);
        if (!next) {
          logger.error("config reload failed, keeping the current config");
          return false;
        }
        config = next;
        runner.setConfig(next);
        scheduler.update(next.cascades);
        logger.info({ cascades: Object.keys(next.cascades).length }, "config reloaded");
        return true;
      },
      stop() {
        stopping ??= (async () => {
          logger.info("stopping");
          scheduler.stop();
          await runner.stop();
          await app.close();
          store.close();
          logger.info("stopped");
        })();
        return stopping;
      },
    };
  } catch (e) {
    store.close();
    throw e;
  }
}

async function readConfig(dir: string, logger: Logger): Promise<Config | undefined> {
  const loaded = await loadConfig({ path: dir });
  for (const d of loaded.diagnostics) {
    logger[d.severity === "error" ? "error" : "warn"]({ file: d.file, line: d.line, col: d.col }, formatDiagnostic(d));
  }
  return loaded.ok ? loaded.config : undefined;
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
