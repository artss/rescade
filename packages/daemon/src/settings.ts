import { parseArgs } from "node:util";
import { parseDuration, readTokenFile } from "@rescade/core";

export const DEFAULT_ADDR = "127.0.0.1:8765";
export const DEFAULT_DATA_DIR = "/var/lib/rescade";
export const DEFAULT_TOKEN_FILE = "/etc/rescade/token";

export interface Settings {
  host: string;
  port: number;
  configDir: string;
  dataDir: string;
  restic: string;
  repoCheckTimeoutMs?: number;
  token: string;
  /** RESCADE_ALLOWED_HOSTS: Host header values accepted besides loopback and the listen address. */
  extraHosts: string[];
  /** Origins that may call the API from a browser. */
  corsOrigins: Set<string>;
  logLevel: string;
}

export const USAGE = `rescaded - the rescade daemon

Usage:
  rescaded [--addr <host:port>] [--config-dir <path>] [--data-dir <path>] [--restic <path>]
           [--token-file <path>] [--log-level <level>]

Options (and the environment variables they override):
  --addr <host:port>    where the API listens (RESCADE_ADDR, default ${DEFAULT_ADDR})
  --config-dir <path>   directory with *.yaml files, or a single file (RESCADE_CONFIG_DIR, default ./config)
  --data-dir <path>     run history (RESCADE_DATA_DIR, default ${DEFAULT_DATA_DIR})
  --restic <path>       restic binary (RESCADE_RESTIC, default restic)
  --token-file <path>   API token (RESCADE_TOKEN_FILE, default ${DEFAULT_TOKEN_FILE});
                        RESCADE_TOKEN gives the token itself
  --log-level <level>   trace, debug, info, warn, error (RESCADE_LOG_LEVEL, default info)
  -h, --help            show this help

Environment:
  RESCADE_REPO_CHECK_TIMEOUT   how long to wait for a repo to answer, e.g. "30s" (default 2m)
  RESCADE_ALLOWED_HOSTS        extra values of the Host header to accept, comma-separated,
                               "host" or "host:port" (needed when listening on a public address)
  RESCADE_CORS_ORIGINS         origins allowed to call the API from a browser, comma-separated

Signals: SIGHUP reloads the config, SIGTERM stops (runs in progress end as interrupted).
`;

export class SettingsError extends Error {}

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/** Reads the daemon's settings from flags and the environment. `warn` gets non-fatal problems. */
export async function readSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
): Promise<Settings | "help"> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        addr: { type: "string" },
        "config-dir": { type: "string" },
        "data-dir": { type: "string" },
        restic: { type: "string" },
        "token-file": { type: "string" },
        "log-level": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    throw new SettingsError(e instanceof Error ? e.message : String(e));
  }
  if (values.help) return "help";
  const pick = (flag: string | undefined, name: string, fallback: string): string => {
    const value = env[name];
    return flag ?? (value === undefined || value === "" ? fallback : value);
  };

  const { host, port } = parseAddr(pick(values.addr, "RESCADE_ADDR", DEFAULT_ADDR));

  let repoCheckTimeoutMs: number | undefined;
  const checkTimeout = env.RESCADE_REPO_CHECK_TIMEOUT;
  if (checkTimeout !== undefined && checkTimeout !== "") {
    try {
      repoCheckTimeoutMs = parseDuration(checkTimeout);
    } catch {
      throw new SettingsError(`RESCADE_REPO_CHECK_TIMEOUT: expected a duration such as "30s" or "5m", got "${checkTimeout}"`);
    }
  }

  const logLevel = pick(values["log-level"], "RESCADE_LOG_LEVEL", "info");
  if (!LOG_LEVELS.has(logLevel)) throw new SettingsError(`unknown log level "${logLevel}"`);

  return {
    host,
    port,
    configDir: pick(values["config-dir"], "RESCADE_CONFIG_DIR", "config"),
    dataDir: pick(values["data-dir"], "RESCADE_DATA_DIR", DEFAULT_DATA_DIR),
    restic: pick(values.restic, "RESCADE_RESTIC", "restic"),
    repoCheckTimeoutMs,
    token: await readToken(values["token-file"], env, warn),
    extraHosts: list(env.RESCADE_ALLOWED_HOSTS),
    corsOrigins: new Set(list(env.RESCADE_CORS_ORIGINS)),
    logLevel,
  };
}

/** "127.0.0.1:8765", "[::1]:8765", "localhost:8765". */
export function parseAddr(addr: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d+)$/.exec(addr);
  const port = Number(m?.[3]);
  if (!m || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new SettingsError(`expected an address such as "127.0.0.1:8765" or "[::1]:8765", got "${addr}"`);
  }
  return { host: (m[1] ?? m[2])!, port };
}

/** The token is required: the API is never open without one. */
async function readToken(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
): Promise<string> {
  if (flag === undefined && env.RESCADE_TOKEN !== undefined && env.RESCADE_TOKEN !== "") return env.RESCADE_TOKEN;
  const file = flag ?? (env.RESCADE_TOKEN_FILE || DEFAULT_TOKEN_FILE);
  try {
    const { token, warning } = await readTokenFile(file);
    if (warning !== undefined) warn(warning);
    return token;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new SettingsError(
      `no API token: ${why}\n` +
        `create one with: (umask 077; openssl rand -hex 32 > ${file}), or set RESCADE_TOKEN or RESCADE_TOKEN_FILE`,
    );
  }
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Loopback names and the listen address on our port, plus RESCADE_ALLOWED_HOSTS (without a port: ours). */
export function allowedHosts(host: string, port: number, extra: string[]): Set<string> {
  const bracket = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
  const names = ["localhost", "127.0.0.1", "[::1]", bracket(host)].map((h) => `${h}:${port}`);
  for (const e of extra) names.push(/^(\[[^\]]+\]|[^:]+):\d+$/.test(e) ? e : `${bracket(e)}:${port}`);
  return new Set(names.map((n) => n.toLowerCase()));
}
