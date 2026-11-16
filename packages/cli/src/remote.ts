import {
  formatDuration,
  type LogRecord,
  type RepoLockList,
  type RunRecord,
  type Snapshot,
  type SnapshotDir,
  type StepRecord,
} from "@rescade/core";
import type { ApiClient, ServerEvent } from "./client.js";
import { formatBytes, formatTime, logLine, RUN_EXIT, stepLine, table } from "./output.js";

/** The parts of `GET /cascades` the CLI shows. */
interface CascadeView {
  name: string;
  description: string | null;
  schedule: string[];
  steps: Array<{ type: string; label: string }>;
  nextRun: number | null;
  active: RunRecord | null;
  lastRun: RunRecord | null;
}

/** The parts of `GET /repos` the CLI shows. */
interface RepoView {
  name: string;
  location: string;
  from?: string;
  state: string;
  reason?: string;
  checkedAt?: number;
  locks?: RepoLockList;
  lockedBy?: { runId: number; cascade: string };
}

/** `GET /status`. */
interface DaemonView {
  version: string;
  startedAt: number;
  config: { path: string; loadedAt: number; lastReload?: { at: number; ok: boolean; errors: string[] } };
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const finished = (status: string) => status !== "running" && status !== "queued";
const exitCode = (status: RunRecord["status"]) => (finished(status) ? RUN_EXIT[status as keyof typeof RUN_EXIT] : 1);

/**
 * Starts the cascade on the daemon and follows it like `run --local` does, unless `detach`.
 * The first Ctrl+C asks the daemon to cancel the run, the second leaves it running and exits.
 */
export async function runRemote(client: ApiClient, cascade: string, detach: boolean, json: boolean): Promise<number> {
  if (detach) {
    const run = await client.post<RunRecord>(`/cascades/${encodeURIComponent(cascade)}/run`);
    if (json) print(run);
    else console.log(run.status === "skipped" ? `run ${run.id} skipped: ${run.reason}` : `run ${run.id} started`);
    return run.status === "skipped" ? RUN_EXIT.skipped : 0;
  }

  const cascades = await client.get<CascadeView[]>("/cascades");
  const total = cascades.find((c) => c.name === cascade)?.steps.length;
  const tag = (index: number) => (total === undefined ? `[${index + 1}]` : `[${index + 1}/${total}]`);

  // subscribe first: events of the run may come before the answer to the POST
  const ac = new AbortController();
  const events = await client.events(`?cascade=${encodeURIComponent(cascade)}`, ac.signal);
  let run: RunRecord;
  try {
    run = await client.post<RunRecord>(`/cascades/${encodeURIComponent(cascade)}/run`);
  } catch (e) {
    ac.abort();
    throw e;
  }
  if (run.status === "skipped") {
    ac.abort();
    if (json) print(run);
    else console.error(`run ${run.id} skipped: ${run.reason}`);
    return RUN_EXIT.skipped;
  }
  if (!json) console.log(`run ${run.id} of "${cascade}" started`);

  let cancelling = false;
  const onSignal = () => {
    if (cancelling) {
      console.error(`\nleaving run ${run.id} to the daemon`);
      process.exit(130);
    }
    cancelling = true;
    console.error(`\ncancelling run ${run.id} (press Ctrl+C again to stop following it)`);
    client.post(`/runs/${run.id}/cancel`).catch((e: unknown) => console.error(`rescade: ${(e as Error).message}`));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let last: RunRecord | undefined;
  try {
    for await (const e of events) {
      if (json) {
        if (belongsTo(e, run.id)) process.stdout.write(JSON.stringify(e) + "\n");
      } else {
        printEvent(e, run.id, tag);
      }
      if (e.kind === "run" && (e.run as RunRecord).id === run.id && finished((e.run as RunRecord).status)) {
        last = e.run as RunRecord;
        break;
      }
    }
  } finally {
    ac.abort();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  // the stream ended early (the daemon stopped): ask for the outcome
  last ??= await client.get<RunRecord>(`/runs/${run.id}`);
  if (!json) {
    const took = last.finishedAt === undefined ? "" : ` in ${formatDuration(last.finishedAt - last.startedAt)}`;
    console.log(`cascade "${cascade}": ${last.status}${took}${last.reason === undefined ? "" : ` (${last.reason})`}`);
  }
  return exitCode(last.status);
}

function belongsTo(e: ServerEvent, runId: number): boolean {
  if (e.kind === "run") return (e.run as RunRecord).id === runId;
  if (e.kind === "step") return (e.step as StepRecord).runId === runId;
  if (e.kind === "log") return e.runId === runId;
  return false;
}

function printEvent(e: ServerEvent, runId: number, tag: (index: number) => string): void {
  if (!belongsTo(e, runId)) return;
  if (e.kind === "step") {
    const s = e.step as StepRecord;
    if (s.status === "queued") console.log(`... ${tag(s.index)} waiting: ${s.reason ?? s.label}`);
    else if (s.status === "running") console.log(`==> ${tag(s.index)} ${s.label}`);
    else console.log(stepLine(s, tag(s.index)));
  } else if (e.kind === "log") {
    const l = e.log as LogRecord;
    (l.stream === "stdout" ? console.log : console.error)(logLine(l.stream, l.line));
  }
}

export async function status(client: ApiClient, json: boolean): Promise<number> {
  const [daemon, cascades] = await Promise.all([client.get<DaemonView>("/status"), client.get<CascadeView[]>("/cascades")]);
  if (json) {
    print({ daemon, cascades });
    return 0;
  }
  const { config } = daemon;
  console.log(`rescaded ${daemon.version}, up since ${formatTime(daemon.startedAt)}`);
  console.log(`config ${config.path}, loaded ${formatTime(config.loadedAt)}`);
  if (config.lastReload && !config.lastReload.ok) {
    console.log(`reload at ${formatTime(config.lastReload.at)} failed, the config loaded before stays in use:`);
    for (const e of config.lastReload.errors) console.log(`  ${e}`);
  }
  console.log();
  const rows = [["CASCADE", "LAST RUN", "NEXT RUN", "NOW"]];
  for (const c of cascades) {
    const last = c.lastRun ? `${c.lastRun.status} ${formatTime(c.lastRun.startedAt)} (run ${c.lastRun.id})` : "-";
    const next = c.nextRun === null ? "manual" : formatTime(c.nextRun);
    const now = c.active ? `${c.active.status} (run ${c.active.id})` : "-";
    rows.push([c.name, last, next, now]);
  }
  console.log(table(rows));
  return 0;
}

export async function listRuns(
  client: ApiClient,
  query: { cascade?: string; limit?: string; before?: string },
  json: boolean,
): Promise<number> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
  const runs = await client.get<RunRecord[]>(`/runs${params.size > 0 ? `?${params}` : ""}`);
  if (json) {
    print(runs);
    return 0;
  }
  const rows = [["ID", "CASCADE", "TRIGGER", "STATUS", "STARTED", "TOOK", "REASON"]];
  for (const r of runs) {
    const took = r.finishedAt === undefined ? "-" : formatDuration(r.finishedAt - r.startedAt);
    rows.push([String(r.id), r.cascade, r.trigger, r.status, formatTime(r.startedAt), took, r.reason ?? ""]);
  }
  console.log(table(rows));
  return 0;
}

export async function showRun(client: ApiClient, id: string, json: boolean): Promise<number> {
  const run = await client.get<RunRecord & { steps: StepRecord[] }>(`/runs/${encodeURIComponent(id)}`);
  if (json) {
    print(run);
    return 0;
  }
  const took = run.finishedAt === undefined ? "" : ` in ${formatDuration(run.finishedAt - run.startedAt)}`;
  console.log(`run ${run.id} of "${run.cascade}" (${run.trigger}), started ${formatTime(run.startedAt)}: ${run.status}${took}`);
  if (run.reason !== undefined) console.log(`  ${run.reason}`);
  for (const s of run.steps) {
    const tag = `[${s.index + 1}]`;
    console.log(s.status === "running" || s.status === "queued" ? `==> ${tag} ${s.label}: ${s.status}` : stepLine(s, tag));
    for (const line of s.stderrTail ?? []) console.log(logLine("stderr", line));
  }
  return 0;
}

export async function showLog(client: ApiClient, id: string, step: string | undefined, json: boolean): Promise<number> {
  const query = step === undefined ? "" : `?step=${encodeURIComponent(String(Number(step) - 1))}`;
  const lines = await client.get<LogRecord[]>(`/runs/${encodeURIComponent(id)}/log${query}`);
  if (json) {
    print(lines);
    return 0;
  }
  let current: number | undefined;
  for (const l of lines) {
    if (l.step !== current && step === undefined) console.log(`==> [${l.step + 1}]`);
    current = l.step;
    console.log(logLine(l.stream, l.line));
  }
  return 0;
}

export async function cancelRun(client: ApiClient, id: string, json: boolean): Promise<number> {
  const result = await client.post<{ cancelling: boolean }>(`/runs/${encodeURIComponent(id)}/cancel`);
  if (json) print(result);
  else console.log(`cancelling run ${id}`);
  return 0;
}

export async function listRepos(client: ApiClient, json: boolean): Promise<number> {
  const repos = await client.get<RepoView[]>("/repos");
  if (json) {
    print(repos);
    return 0;
  }
  const rows = [["REPO", "STATE", "CHECKED", "LOCKED BY", "RESTIC LOCKS", "LOCATION"]];
  for (const r of repos) {
    const locked = r.lockedBy ? `run ${r.lockedBy.runId} (${r.lockedBy.cascade})` : "-";
    rows.push([r.name, r.state, r.checkedAt === undefined ? "-" : formatTime(r.checkedAt), locked, lockCount(r.locks), r.location]);
  }
  console.log(table(rows));
  for (const r of repos) {
    if (r.reason !== undefined) console.log(`${r.name}: ${r.reason}`);
    if (!r.locks) continue;
    for (const l of r.locks.locks) {
      const kind = `${l.exclusive ? "exclusive" : "shared"}${l.stale ? ", stale" : ""}`;
      console.log(`${r.name}: lock ${l.id.slice(0, 8)} (${kind}) by ${l.username}@${l.hostname} pid ${l.pid} at ${formatTime(l.time)}`);
    }
    const unread = r.locks.count - r.locks.locks.length;
    if (unread > 0 && r.locks.error === undefined) console.log(`${r.name}: ${unread} more locks`);
    if (r.locks.error !== undefined) console.log(`${r.name}: ${r.locks.error}`);
  }
  if (repos.some((r) => r.locks?.locks.some((l) => l.stale))) {
    console.log('stale locks are left by restic that did not finish; check nothing uses the repo, then run "restic unlock"');
  }
  return 0;
}

/** "-", "2", "2 (1 stale)"; "?" when the locks could not be read. */
function lockCount(locks: RepoLockList | undefined): string {
  if (!locks) return "-";
  if (locks.error !== undefined && locks.count === 0) return "?";
  const stale = locks.locks.filter((l) => l.stale).length;
  return stale > 0 ? `${locks.count} (${stale} stale)` : String(locks.count);
}

export async function listSnapshots(client: ApiClient, repo: string, json: boolean): Promise<number> {
  const snapshots = await client.get<Snapshot[]>(`/repos/${encodeURIComponent(repo)}/snapshots`);
  if (json) {
    print(snapshots);
    return 0;
  }
  if (snapshots.length === 0) {
    console.log(`no snapshots in "${repo}"`);
    return 0;
  }
  const rows = [["ID", "TIME", "HOST", "SIZE", "TAGS", "PATHS"]];
  for (const s of snapshots) {
    const size = s.size === undefined ? "-" : formatBytes(s.size);
    rows.push([s.shortId, formatTime(s.time), s.hostname, size, s.tags.join(",") || "-", s.paths.join(" ")]);
  }
  console.log(table(rows));
  return 0;
}

export async function listDir(client: ApiClient, repo: string, snapshot: string, dir: string, json: boolean): Promise<number> {
  const query = new URLSearchParams({ path: dir });
  const result = await client.get<SnapshotDir>(
    `/repos/${encodeURIComponent(repo)}/snapshots/${encodeURIComponent(snapshot)}/ls?${query}`,
  );
  if (json) {
    print(result);
    return 0;
  }
  // directories first, as a file manager shows them
  const entries = [...result.entries].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
  const rows = entries.map((e) => [
    e.permissions ?? "-",
    e.size === undefined ? "" : formatBytes(e.size),
    e.mtime === undefined ? "" : formatTime(e.mtime),
    e.type === "dir" ? `${e.name}/` : e.name,
  ]);
  if (rows.length > 0) console.log(table(rows));
  else console.log(`${result.path} is empty`);
  if (result.truncated) console.log(`(only the first ${result.entries.length} entries are shown)`);
  return 0;
}
