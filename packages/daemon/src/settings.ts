import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseDuration, readTokenFile } from "@rescade/core";

export const DEFAULT_ADDR = "127.0.0.1:8765";
export const DEFAULT_DATA_DIR = "/var/lib/rescade";
export const DEFAULT_TOKEN_FILE = "/etc/rescade/token";
export const DEFAULT_HISTORY_RETENTION = "180d";
export const DEFAULT_LOG_RETENTION = "30d";

export interface Settings {
  host: string;
  port: number;
  configDir: string;
  dataDir: string;
  restic: string;
  /** Absolute; snapshots are restored into `<restoreDir>/<short id>`. Undefined = restore is off. */
  restoreDir?: string;
  repoCheckTimeoutMs?: number;
  /** Finished runs older than this are deleted; undefined keeps them forever. */
  historyRetentionMs?: number;
  /** Finished runs older than this lose their log lines. */
  logRetentionMs?: number;
  token: string;
  /** RESCADE_ALLOWED_HOSTS: Host header values accepted besides loopback and the listen address; undefined = any. */
  extraHosts: string[] | undefined;
  /** Origins that may call the API from a browser. */
  corsOrigins: Set<string>;
  /** Where people open the web UI (no trailing slash), for links in notifications. */
  publicUrl?: string;
  logLevel: string;
}

export const USAGE = `rescaded - the rescade daemon

Usage:
  rescaded [--addr <host:port>] [--config-dir <path>] [--data-dir <path>] [--restic <path>]
           [--restore-dir <path>] [--token-file <path>] [--log-level <level>]

Options (and the environment variables they override):
  --addr <host:port>    where the API listens (RESCADE_ADDR, default ${DEFAULT_ADDR})
  --config-dir <path>   directory with *.yaml files, or a single file (RESCADE_CONFIG_DIR, default ./config)
  --data-dir <path>     run history (RESCADE_DATA_DIR, default ${DEFAULT_DATA_DIR})
  --restic <path>       restic binary (RESCADE_RESTIC, default restic)
  --restore-dir <path>  directory to restore snapshots into, as <path>/<short id>; created if missing
                        (RESCADE_RESTORE_DIR; unset = restore is off)
  --token-file <path>   API token (RESCADE_TOKEN_FILE, default ${DEFAULT_TOKEN_FILE});
                        RESCADE_TOKEN gives the token itself
  --log-level <level>   trace, debug, info, warn, error (RESCADE_LOG_LEVEL, default info)
  -h, --help            show this help

Environment:
  RESCADE_REPO_CHECK_TIMEOUT   how long to wait for a repo to answer, e.g. "30s" (default 2m)
  RESCADE_HISTORY_RETENTION    how long to keep finished runs, e.g. "90d" (default ${DEFAULT_HISTORY_RETENTION}, 0 = forever)
  RESCADE_LOG_RETENTION        how long to keep the log lines of finished runs (default ${DEFAULT_LOG_RETENTION},
                               0 = as long as the run); the latest run of each cascade is always kept
  RESCADE_ALLOWED_HOSTS        values of the Host header to accept besides loopback and the listen address,
                               comma-separated: "host:port" only on that port, "host" on any port;
                               unset or empty = any host
  RESCADE_CORS_ORIGINS         origins allowed to call the API from a browser, comma-separated
  RESCADE_PUBLIC_URL           address of the web UI as people open it, e.g. "https://backup.example.com",
                               for links in notifications (unset = no links)

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
        "restore-dir": { type: "string" },
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

  /** With a fallback (the retention settings) "0" means no limit. */
  const durationVar = (name: string, fallback?: string): number | undefined => {
    const value = env[name] || fallback;
    if (value === undefined || (fallback !== undefined && value === "0")) return undefined;
    try {
      return parseDuration(value);
    } catch {
      throw new SettingsError(`${name}: expected a duration such as "30s", "5m" or "90d", got "${value}"`);
    }
  };

  const logLevel = pick(values["log-level"], "RESCADE_LOG_LEVEL", "info");
  if (!LOG_LEVELS.has(logLevel)) throw new SettingsError(`unknown log level "${logLevel}"`);

  return {
    host,
    port,
    configDir: pick(values["config-dir"], "RESCADE_CONFIG_DIR", "config"),
    dataDir: pick(values["data-dir"], "RESCADE_DATA_DIR", DEFAULT_DATA_DIR),
    restic: pick(values.restic, "RESCADE_RESTIC", "restic"),
    ...(await restoreDir(values["restore-dir"] ?? (env.RESCADE_RESTORE_DIR || undefined))),
    repoCheckTimeoutMs: durationVar("RESCADE_REPO_CHECK_TIMEOUT"),
    historyRetentionMs: durationVar("RESCADE_HISTORY_RETENTION", DEFAULT_HISTORY_RETENTION),
    logRetentionMs: durationVar("RESCADE_LOG_RETENTION", DEFAULT_LOG_RETENTION),
    token: await readToken(values["token-file"], env, warn),
    extraHosts: optionalList(env.RESCADE_ALLOWED_HOSTS),
    corsOrigins: new Set(list(env.RESCADE_CORS_ORIGINS)),
    ...publicUrl(env.RESCADE_PUBLIC_URL),
    logLevel,
  };
}

/**
 * The restore directory is created when missing, readable only by the daemon's user (restored files may be secrets).
 * Failing to create it, or something else than a directory in its place, stops the start.
 */
async function restoreDir(dir: string | undefined): Promise<{ restoreDir?: string }> {
  if (dir === undefined) return {};
  const full = path.resolve(dir);
  const info = await stat(full).catch(() => undefined);
  if (info && !info.isDirectory()) throw new SettingsError(`restore directory ${full} is not a directory`);
  if (!info) {
    try {
      await mkdir(full, { recursive: true, mode: 0o700 });
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
      throw new SettingsError(`cannot create restore directory ${full} (${why})`);
    }
  }
  return { restoreDir: full };
}

function publicUrl(value: string | undefined): { publicUrl?: string } {
  if (value === undefined || value.trim() === "") return {};
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    url = new URL("invalid:");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SettingsError(`RESCADE_PUBLIC_URL: expected an http(s) address such as "https://backup.example.com", got "${value}"`);
  }
  return { publicUrl: url.href.replace(/\/+$/, "") };
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

function optionalList(value: string | undefined): string[] | undefined {
  const items = list(value);
  return items.length > 0 ? items : undefined;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const HOST_PORT = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/;

/**
 * Loopback names and the listen address on our port, plus RESCADE_ALLOWED_HOSTS: "host:port" as is,
 * a bare "host" for any port (see `hostAllowed`).
 */
export function allowedHosts(host: string, port: number, extra: string[]): Set<string> {
  const bracket = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
  const names = ["localhost", "127.0.0.1", "[::1]", bracket(host)].map((h) => `${h}:${port}`);
  // what does not parse as a name with an optional port is a bare IPv6 address
  for (const e of extra) names.push(HOST_PORT.test(e) ? e : `[${e}]`);
  return new Set(names.map((n) => n.toLowerCase()));
}

/**
 * Whether a Host header is in `allowed`: as is, or by its name alone when the name is allowed on any port.
 * A header without a port (a proxy on 80/443) matches only such names.
 */
export function hostAllowed(allowed: Set<string>, header: string): boolean {
  const h = header.toLowerCase();
  if (allowed.has(h)) return true;
  const name = HOST_PORT.exec(h)?.[1];
  return name !== undefined && allowed.has(name);
}
