import { runProcess } from "./process.js";
import { OWN_VARS } from "./restic.js";

/** The oldest restic rescade works with: exit codes 10 (no repo) and 12 (wrong password) come from 0.17. */
export const MIN_RESTIC_VERSION = "0.17.0";

const VERSION_TIMEOUT_MS = 10_000;

export interface ResticVersion {
  /** e.g. "0.19.1"; absent when restic did not start or printed something unexpected. */
  version?: string;
  /** Why this restic does not fit, for a warning. */
  warning?: string;
}

/** Reads the version from `restic version` output ("restic 0.19.1 compiled with go1.26.4 on linux/amd64"). */
export function parseResticVersion(output: string): string | undefined {
  return /^restic (\d+\.\d+\.\d+)/m.exec(output)?.[1];
}

function older(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]!;
  }
  return false;
}

/** Runs `restic version` and tells whether this restic is new enough; never throws. */
export async function checkResticVersion(binary: string, baseEnv: Record<string, string | undefined>): Promise<ResticVersion> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined && !OWN_VARS.has(k)) env[k] = v;
  }
  let stdout = "";
  const r = await runProcess({
    command: binary,
    args: ["version"],
    env,
    timeoutMs: VERSION_TIMEOUT_MS,
    onLine: (stream, line) => {
      if (stream === "stdout") stdout += line + "\n";
    },
  });
  if (r.spawnError !== undefined) return { warning: `could not start restic "${binary}": ${r.spawnError}` };
  if (r.timedOut) return { warning: `"${binary} version" did not finish in ${VERSION_TIMEOUT_MS / 1000} s` };
  if (r.code !== 0) {
    const tail = r.stderrTail.at(-1);
    return { warning: `"${binary} version" failed with exit code ${r.code}${tail ? `: ${tail}` : ""}` };
  }
  const version = parseResticVersion(stdout);
  if (version === undefined) {
    return { warning: `could not read the version of restic "${binary}" from: ${stdout.trim().split("\n")[0] ?? ""}` };
  }
  if (older(version, MIN_RESTIC_VERSION)) {
    return {
      version,
      warning:
        `restic ${version} ("${binary}") is older than ${MIN_RESTIC_VERSION}: missing repos will not be initialized ` +
        "and a wrong password will look like an unreachable repo (set RESCADE_RESTIC or --restic to a newer restic)",
    };
  }
  return { version };
}
