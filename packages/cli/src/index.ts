#!/usr/bin/env node
import { parseArgs } from "node:util";
import { formatDiagnostic, loadConfig } from "@rescade/core";

const HELP = `rescade - chains of restic commands

Usage:
  rescade validate [--config-dir <path>] [--allow-missing-env] [--json]

Options:
  --config-dir <path>   directory with *.yaml files, or a single file
                        (default: $RESCADE_CONFIG_DIR, then ./config)
  --allow-missing-env   report unset \${VAR} as warnings instead of errors
  --json                machine-readable output
  -h, --help            show this help

Exit codes: 0 valid, 1 config has errors, 2 bad usage
`;

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
    console.error(`rescade: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
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
