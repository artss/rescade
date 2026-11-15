#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  formatDiagnostic,
  formatDuration,
  loadConfig,
  parseDuration,
  runChain,
  type RunEvent,
  type RunStatus,
  type StepResult,
} from "@rescade/core";

const HELP = `rescade - chains of restic commands

Usage:
  rescade validate [--config-dir <path>] [--allow-missing-env] [--json]
  rescade run --local <chain> [--config-dir <path>] [--restic <path>]

Options:
  --config-dir <path>   directory with *.yaml files, or a single file
                        (default: $RESCADE_CONFIG_DIR, then ./config)
  --allow-missing-env   validate: report unset \${VAR} as warnings instead of errors
  --json                validate: machine-readable output
  --local               run: run the chain in this process, without the daemon
  --restic <path>       run: restic binary (default: $RESCADE_RESTIC, then restic)

Environment:
  RESCADE_REPO_CHECK_TIMEOUT   how long to wait for a repo to answer before a step,
                               e.g. "30s" or "5m" (default: 2m)
  -h, --help            show this help

Exit codes:
  validate  0 valid, 1 config has errors, 2 bad usage
  run       0 success, 3 warning, 1 failed or config errors, 130 canceled, 2 bad usage
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
      `ok: ${s.repos} repos, ${s.sets} sets, ${s.chains} chains from ${result.files.length} file${result.files.length === 1 ? "" : "s"}${w}`,
    );
    return 0;
  }
  console.error(`failed: ${errors} error${errors === 1 ? "" : "s"}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`);
  return 1;
}

const RUN_EXIT: Record<RunStatus, number> = { success: 0, warning: 3, failed: 1, cancelled: 130 };

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "config-dir": { type: "string" },
        local: { type: "boolean", default: false },
        restic: { type: "string" },
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
    console.error("rescade: run needs exactly one chain name");
    return 2;
  }
  if (!values.local) {
    console.error("rescade: the daemon is not implemented yet; use run --local to run the chain in this process");
    return 2;
  }
  const chainName = positionals[0]!;

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
  const chain = loaded.config.chains[chainName];
  if (!chain) {
    const known = Object.keys(loaded.config.chains).join(", ") || "none";
    console.error(`rescade: unknown chain "${chainName}" (defined: ${known})`);
    return 1;
  }

  // first Ctrl+C: SIGTERM to the running step and wait; second: leave at once
  const ac = new AbortController();
  const onSignal = () => {
    if (ac.signal.aborted) process.exit(130);
    console.error("\ncancelling: waiting for the current step to stop (press Ctrl+C again to exit at once)");
    ac.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const total = chain.steps.length;
  const tag = (index: number) => `[${index + 1}/${total}]`;
  const onEvent = (e: RunEvent) => {
    switch (e.kind) {
      case "step-start":
        console.log(`==> ${tag(e.index)} ${e.label}`);
        break;
      case "log":
        (e.stream === "stdout" ? console.log : console.error)(`    ${e.stream === "info" ? "rescade: " : ""}${e.line}`);
        break;
      case "step-end":
        console.log(stepLine(e.result, tag(e.result.index)));
        break;
    }
  };

  const result = await runChain(loaded.config, chainName, {
    restic: values.restic ?? process.env.RESCADE_RESTIC ?? "restic",
    env: process.env,
    signal: ac.signal,
    repoCheckTimeoutMs,
    onEvent,
  });
  console.log(`chain "${chainName}": ${result.status} in ${formatDuration(result.finishedAt - result.startedAt)}`);
  return RUN_EXIT[result.status];
}

function stepLine(r: StepResult, tag: string): string {
  if (r.status === "skipped") return `--- ${tag} skipped: ${r.label}`;
  const took = r.durationMs === undefined ? "" : ` in ${formatDuration(r.durationMs)}`;
  return `<== ${tag} ${r.status}${took}${r.reason === undefined ? "" : `: ${r.reason}`}`;
}

function summarize(config: Awaited<ReturnType<typeof loadConfig>>["config"]) {
  if (!config) return undefined;
  return {
    repos: Object.keys(config.repos).length,
    sets: Object.keys(config.sets).length,
    chains: Object.keys(config.chains).length,
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "validate":
      return validate(rest);
    case "run":
      return run(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return command === undefined ? 2 : 0;
    default:
      console.error(`rescade: unknown command "${command}"\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(70);
  },
);
