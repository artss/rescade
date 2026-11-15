import { spawn } from "node:child_process";

export type Stream = "stdout" | "stderr";

export interface ProcessOptions {
  command: string;
  args: string[];
  /** The complete environment of the child; nothing is inherited. */
  env: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Time between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  onLine?: (stream: Stream, line: string) => void;
}

export interface ProcessResult {
  /** null when the process was killed by a signal or could not be started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the program could not be started (ENOENT, EACCES, bad cwd). */
  spawnError?: string;
  /** Last lines of stderr, for failure reasons. */
  stderrTail: string[];
  /**
   * After a timeout or cancel: the last non-empty stderr line written before rescade sent SIGTERM,
   * i.e. what the process was stuck on (what it prints while shutting down is noise).
   */
  stderrBeforeStop?: string;
}

export const DEFAULT_KILL_GRACE_MS = 30_000;
const TAIL_LINES = 20;

/**
 * Runs a program without a shell and reports its output line by line.
 * The child gets its own process group, so a timeout or cancel also stops whatever it started
 * (a shell script and its pg_dump, for example): SIGTERM to the group, SIGKILL after the grace period.
 */
export function runProcess(o: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const stderrTail: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let stderrBeforeStop: string | undefined;
    let finished = false;

    if (o.signal?.aborted) {
      resolve({ code: null, signal: null, timedOut, cancelled: true, stderrTail });
      return;
    }

    const child = spawn(o.command, o.args, {
      env: o.env,
      cwd: o.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const emit = (stream: Stream, line: string) => {
      if (stream === "stderr") {
        stderrTail.push(line);
        if (stderrTail.length > TAIL_LINES) stderrTail.shift();
      }
      o.onLine?.(stream, line);
    };
    const splitter = (stream: Stream) => {
      let buf = "";
      return {
        push(chunk: string) {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            emit(stream, visible(buf.slice(0, i)));
            buf = buf.slice(i + 1);
          }
        },
        flush() {
          if (buf !== "") emit(stream, visible(buf));
          buf = "";
        },
      };
    };
    const out = splitter("stdout");
    const err = splitter("stderr");
    child.stdout.setEncoding("utf8").on("data", out.push);
    child.stderr.setEncoding("utf8").on("data", err.push);

    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // the group is already gone
      }
    };
    const terminate = () => {
      if (killTimer) return;
      stderrBeforeStop = stderrTail.filter((l) => l.trim() !== "").at(-1);
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), o.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };

    const timeout =
      o.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, o.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      o.signal?.removeEventListener("abort", onAbort);
      out.flush();
      err.flush();
      resolve({ code, signal, timedOut, cancelled, spawnError, stderrTail, stderrBeforeStop });
    };

    child.on("error", (e) => {
      spawnError = e.message;
      // without a pid the child never started and "close" may not follow
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", finish);
  });
}

/** What a terminal would show: text after the last carriage return, without trailing spaces. */
function visible(line: string): string {
  const text = line.replace(/\r+$/, "");
  return text.slice(text.lastIndexOf("\r") + 1).trimEnd();
}
