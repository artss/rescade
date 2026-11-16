#!/usr/bin/env node
import { pino } from "pino";
import { readSettings, SettingsError, startDaemon, StartupError, USAGE } from "./daemon.js";

async function main(): Promise<number> {
  const early: string[] = [];
  let settings;
  try {
    settings = await readSettings(process.argv.slice(2), process.env, (m) => early.push(m));
  } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    console.error(`rescaded: ${e.message}`);
    return 2;
  }
  if (settings === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const logger = pino({ level: settings.logLevel });
  for (const m of early) logger.warn(m);

  let daemon;
  try {
    daemon = await startDaemon(settings, logger, { env: process.env });
  } catch (e) {
    if (e instanceof StartupError) logger.fatal(`cannot start: ${e.message}`);
    else logger.fatal({ err: e }, "cannot start");
    return 1;
  }

  process.on("SIGHUP", () => void daemon.reload());
  // once: a second signal gets the default handling and ends the process at once
  return new Promise((resolve) => {
    const onStop = (signal: string) => {
      logger.info({ signal }, "signal received");
      daemon.stop().then(
        () => resolve(0),
        (err: unknown) => {
          logger.error({ err }, "error while stopping");
          resolve(1);
        },
      );
    };
    process.once("SIGTERM", () => onStop("SIGTERM"));
    process.once("SIGINT", () => onStop("SIGINT"));
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(70);
  },
);
