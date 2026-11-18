#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  checkResticVersion,
  formatDiagnostic,
  formatDuration,
  loadConfig,
  parseDuration,
  runCascade,
  type RunEvent,
} from "@rescade/core";
import { ApiClient, ClientError, resolveConnection } from "./client.js";
import { logLine, RUN_EXIT, stepLine } from "./output.js";
import { VERSION } from "./version.js";
import {
  cancelRun,
  listDir,
  listRepos,
  listRuns,
  listSnapshots,
  restoreRemote,
  runRemote,
  showLog,
  showRun,
  status,
} from "./remote.js";

const HELP = `rescade - cascades of restic commands

Usage:
  rescade validate [--config-dir <path>] [--allow-missing-env] [--json]
  rescade run --local <cascade> [--config-dir <path>] [--restic <path>]

  through the daemon:
  rescade run <cascade> [--detach]    start a cascade and follow it (Ctrl+C cancels it)
  rescade status                      the daemon, its config, cascades with their last and next runs
  rescade runs [--cascade <name>] [--limit <n>] [--before <id>]
  rescade show <run>                  a run and its steps
  rescade log <run> [--step <n>]      the log of a run (steps count from 1)
  rescade cancel <run>
  rescade repos                       repo state and who holds them
  rescade snapshots <repo>            snapshots of a repo, newest first
  rescade ls <repo> <snapshot> [path] what is in a directory of a snapshot (default /)
  rescade restore <repo> <snapshot> [path...] [--detach]
                                      restore the snapshot, or only these paths, into the daemon's
                                      restore directory: <restore-dir>/<short id>/<full path>

Options:
  --config-dir <path>   directory with *.yaml files, or a single file
                        (default: $RESCADE_CONFIG_DIR, then ./config)
  --allow-missing-env   validate: report unset \${VAR} as warnings instead of errors
  --json                machine-readable output
  --local               run: run the cascade in this process, without the daemon
  --restic <path>       run --local: restic binary (default: $RESCADE_RESTIC, then restic)
  --detach              run, restore: only start the run and print its id
  --url <url>           the daemon (default: $RESCADE_URL, then http://127.0.0.1:8765)
  --token-file <path>   API token (default: $RESCADE_TOKEN, $RESCADE_TOKEN_FILE,
                        then ~/.config/rescade/token)
  -h, --help            show this help
  -V, --version         show the version of rescade

Environment:
  RESCADE_REPO_CHECK_TIMEOUT   run --local: how long to wait for a repo to answer before a step,
                               e.g. "30s" or "5m" (default: 2m)

Exit codes:
  validate  0 valid, 1 config has errors, 2 bad usage
  run       0 success, 3 warning, 1 failed, interrupted or config errors, 130 cancelled,
            75 skipped (repos busy or the cascade already running), 2 bad usage
  restore   0 success, 1 failed or interrupted, 130 cancelled, 2 bad usage
  others    0 done, 1 error from the daemon or no connection, 2 bad usage
`;

function usageError(e: unknown): number {
  console.error(`rescade: ${e instanceof Error ? e.message : String(e)}`);
  return 2;
}

async function validate(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "config-dir": { type: "string" },
        "allow-missing-env": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
  } catch (e) {
    return usageError(e);
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const target = values["config-dir"] ?? process.env.RESCADE_CONFIG_DIR ?? "config";
  const result = await loadConfig({
    path: target,
    missingEnv: values["allow-missing-env"] ? "warn" : "error",
  });

  if (values.json) {
    const { config, ...rest } = result;
    process.stdout.write(JSON.stringify({ ...rest, summary: summarize(config) }, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }

  const cwd = process.cwd();
  for (const d of result.diagnostics) console.error(formatDiagnostic(d, cwd));

  const errors = result.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = result.diagnostics.length - errors;
  if (result.ok && result.config) {
    const s = summarize(result.config)!;
    const w = warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
    console.log(
      `ok: ${s.repos} repos, ${s.sets} sets, ${s.cascades} cascades from ${result.files.length} file${result.files.length === 1 ? "" : "s"}${w}`,
    );
    return 0;
  }
  console.error(`failed: ${errors} error${errors === 1 ? "" : "s"}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`);
  return 1;
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "config-dir": { type: "string" },
        local: { type: "boolean", default: false },
        restic: { type: "string" },
        detach: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        ...CONNECTION_OPTIONS,
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    return usageError(e);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    console.error("rescade: run needs exactly one cascade name");
    return 2;
  }
  const cascadeName = positionals[0]!;
  if (!values.local) {
    return runRemote(await connect(values), cascadeName, values.detach, values.json);
  }

  let repoCheckTimeoutMs: number | undefined;
  const checkTimeout = process.env.RESCADE_REPO_CHECK_TIMEOUT;
  if (checkTimeout !== undefined && checkTimeout !== "") {
    try {
      repoCheckTimeoutMs = parseDuration(checkTimeout);
    } catch {
      console.error(`rescade: RESCADE_REPO_CHECK_TIMEOUT: expected a duration such as "30s" or "5m", got "${checkTimeout}"`);
      return 2;
    }
  }

  const target = values["config-dir"] ?? process.env.RESCADE_CONFIG_DIR ?? "config";
  const loaded = await loadConfig({ path: target });
  const cwd = process.cwd();
  for (const d of loaded.diagnostics) console.error(formatDiagnostic(d, cwd));
  if (!loaded.ok || !loaded.config) {
    console.error("failed: the config has errors");
    return 1;
  }
  const cascade = loaded.config.cascades[cascadeName];
  if (!cascade) {
    const known = Object.keys(loaded.config.cascades).join(", ") || "none";
    console.error(`rescade: unknown cascade "${cascadeName}" (defined: ${known})`);
    return 1;
  }

  const restic = values.restic ?? process.env.RESCADE_RESTIC ?? "restic";
  const version = await checkResticVersion(restic, process.env);
  if (version.warning !== undefined) console.error(`rescade: warning: ${version.warning}`);

  // first Ctrl+C: SIGTERM to the running step and wait; second: leave at once
  const ac = new AbortController();
  const onSignal = () => {
    if (ac.signal.aborted) process.exit(130);
    console.error("\ncancelling: waiting for the current step to stop (press Ctrl+C again to exit at once)");
    ac.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const total = cascade.steps.length;
  const tag = (index: number) => `[${index + 1}/${total}]`;
  const onEvent = (e: RunEvent) => {
    switch (e.kind) {
      case "step-start":
        console.log(`==> ${tag(e.index)} ${e.label}`);
        break;
      case "log":
        (e.stream === "stdout" ? console.log : console.error)(logLine(e.stream, e.line));
        break;
      case "step-end":
        console.log(stepLine(e.result, tag(e.result.index)));
        break;
    }
  };

  const result = await runCascade(loaded.config, cascadeName, {
    restic,
    env: process.env,
    signal: ac.signal,
    repoCheckTimeoutMs,
    onEvent,
  });
  console.log(`cascade "${cascadeName}": ${result.status} in ${formatDuration(result.finishedAt - result.startedAt)}`);
  return RUN_EXIT[result.status];
}

async function restore(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        detach: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        ...CONNECTION_OPTIONS,
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    return usageError(e);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const [repo, snapshot, ...paths] = positionals;
  if (repo === undefined || snapshot === undefined) {
    console.error("rescade: restore needs a repo, a snapshot id and optionally paths");
    return 2;
  }
  const relative = paths.find((p) => !p.startsWith("/"));
  if (relative !== undefined) {
    console.error(`rescade: paths to restore are absolute paths in the snapshot, got "${relative}"`);
    return 2;
  }
  return restoreRemote(await connect(values), repo, snapshot, paths, values.detach, values.json);
}

const CONNECTION_OPTIONS = {
  url: { type: "string" },
  "token-file": { type: "string" },
} as const;

async function connect(values: { url?: string; "token-file"?: string }): Promise<ApiClient> {
  const conn = await resolveConnection({ url: values.url, tokenFile: values["token-file"] }, process.env, (m) =>
    console.error(`rescade: warning: ${m}`),
  );
  return new ApiClient(conn);
}

/** Positional arguments of each command: how many at least and at most. */
const ARITY: Record<string, [number, number, string]> = {
  status: [0, 0, "takes no arguments"],
  runs: [0, 0, "takes no arguments"],
  repos: [0, 0, "takes no arguments"],
  show: [1, 1, "needs one run id"],
  log: [1, 1, "needs one run id"],
  cancel: [1, 1, "needs one run id"],
  snapshots: [1, 1, "needs one repo name"],
  ls: [2, 3, "needs a repo, a snapshot id and optionally a path"],
};

/** Commands that only ask the daemon: status, runs, show, log, cancel, repos, snapshots, ls. */
async function remote(command: string, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        ...CONNECTION_OPTIONS,
        json: { type: "boolean", default: false },
        cascade: { type: "string" },
        limit: { type: "string" },
        before: { type: "string" },
        step: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    return usageError(e);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const [min, max, usage] = ARITY[command]!;
  if (positionals.length < min || positionals.length > max) {
    console.error(`rescade: ${command} ${usage}`);
    return 2;
  }
  const runId = command === "show" || command === "log" || command === "cancel" ? positionals[0] : undefined;
  for (const [name, value] of [["limit", values.limit], ["before", values.before], ["step", values.step], ["run id", runId]]) {
    if (value !== undefined && !/^[1-9]\d*$/.test(value)) {
      console.error(`rescade: ${name} must be a positive number, got "${value}"`);
      return 2;
    }
  }
  const allowed: Record<string, string[]> = { runs: ["cascade", "limit", "before"], log: ["step"] };
  for (const name of ["cascade", "limit", "before", "step"] as const) {
    if (values[name] !== undefined && !(allowed[command] ?? []).includes(name)) {
      console.error(`rescade: ${command} does not take --${name}`);
      return 2;
    }
  }

  const client = await connect(values);
  const id = positionals[0]!;
  switch (command) {
    case "status":
      return status(client, values.json);
    case "runs":
      return listRuns(client, { cascade: values.cascade, limit: values.limit, before: values.before }, values.json);
    case "show":
      return showRun(client, id, values.json);
    case "log":
      return showLog(client, id, values.step, values.json);
    case "cancel":
      return cancelRun(client, id, values.json);
    case "snapshots":
      return listSnapshots(client, id, values.json);
    case "ls":
      return listDir(client, id, positionals[1]!, positionals[2] ?? "/", values.json);
    default:
      return listRepos(client, values.json);
  }
}

function summarize(config: Awaited<ReturnType<typeof loadConfig>>["config"]) {
  if (!config) return undefined;
  return {
    repos: Object.keys(config.repos).length,
    sets: Object.keys(config.sets).length,
    cascades: Object.keys(config.cascades).length,
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "validate":
      return validate(rest);
    case "run":
      return run(rest);
    case "restore":
      return restore(rest);
    case "status":
    case "runs":
    case "show":
    case "log":
    case "cancel":
    case "repos":
    case "snapshots":
    case "ls":
      return remote(command, rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return command === undefined ? 2 : 0;
    case "-V":
    case "--version":
      console.log(`rescade ${VERSION}`);
      return 0;
    default:
      console.error(`rescade: unknown command "${command}"\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ClientError) {
      console.error(`rescade: ${err.message}`);
      process.exit(1);
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(70);
  },
);
