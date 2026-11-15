import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pino } from "pino";
import type { TestProject } from "vitest/node";
import { startDaemon } from "../../daemon/src/daemon.js";
import { FAKE_RESTIC, FakeState } from "../../core/test/helpers/fake.js";

declare module "vitest" {
  export interface ProvidedContext {
    daemonUrl: string;
    token: string;
    /** Writing `release` here lets the `slow` cascade finish. */
    fakeDir: string;
  }
}

const TOKEN = "web-test-token-0123456789";

/** A real daemon (runner, scheduler, SQLite store, HTTP API) with the fake restic. */
export default async function setup(project: TestProject) {
  const fake = await FakeState.create();
  const hold = JSON.stringify([
    process.execPath,
    "-e",
    "const f = process.argv[1]; console.log('holding'); const t = setInterval(() => require('fs').existsSync(f) && clearInterval(t), 10)",
    path.join(fake.dir, "release"),
  ]);
  const configFile = path.join(fake.dir, "rescade.yaml");
  await writeFile(
    configFile,
    `
repos:
  a: { path: /r/a, password: pw-a, retention: { daily: 7 } }
  b: { path: /r/b, password: pw-b, from: a }
cascades:
  daily:
    description: Forget old snapshots
    schedule: "0 3 * * *"
    steps:
      - retain: { repo: a }
  slow:
    steps:
      - run: { command: ${hold}, lock: [b] }
`,
  );
  const daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      configDir: configFile,
      dataDir: path.join(fake.dir, "data"),
      restic: FAKE_RESTIC,
      token: TOKEN,
      extraHosts: [],
      corsOrigins: new Set(),
      logLevel: "silent",
    },
    pino({ level: "silent" }),
    { env: fake.env(), killGraceMs: 500, heartbeatMs: 1000, webDir: null },
  );
  project.provide("daemonUrl", `http://${daemon.address}`);
  project.provide("token", TOKEN);
  project.provide("fakeDir", fake.dir);
  return async () => {
    await daemon.stop();
    await fake.remove();
  };
}
