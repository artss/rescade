import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { LogStream, RunStatus, StepStatus, StepType } from "../run/cascade.js";

export type Trigger = "schedule" | "manual";

/** `queued`: a step waits for busy repos (`on-busy: wait`). `interrupted`: the daemon stopped during the run. */
export type RunState = "queued" | "running" | RunStatus | "interrupted";
export type StepState = "queued" | "running" | StepStatus | "interrupted";

/** A restore run: what was restored, and where to. */
export interface RestoreRecord {
  repo: string;
  snapshot: string;
  /** Empty: the whole snapshot. */
  paths: string[];
  target: string;
}

/** A run of a cascade (`cascade`) or a restore (`restore`). */
export interface RunRecord {
  id: number;
  cascade?: string;
  restore?: RestoreRecord;
  trigger: Trigger;
  /** A rerun: the run whose failed step it starts from. */
  rerunOf?: number;
  /** A rerun: the index of the first step it runs; earlier steps were done in `rerunOf` and have no records here. */
  fromStep?: number;
  status: RunState;
  reason?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  finishedAt?: number;
}

export interface StepRecord {
  runId: number;
  index: number;
  type: StepType;
  label: string;
  /** backup: the repo the snapshot goes to; restore: the repo it comes from. */
  repo?: string;
  status: StepState;
  exitCode?: number;
  startedAt?: number;
  durationMs?: number;
  reason?: string;
  stderrTail?: string[];
  summary?: Record<string, unknown>;
}

export interface LogRecord {
  /** Grows with every line of every run; `after` in `Store.log` continues from it. */
  id: number;
  step: number;
  ts: number;
  stream: LogStream;
  line: string;
}

export interface RunQuery {
  cascade?: string;
  /** Newest first; default 50. */
  limit?: number;
  /** Only runs with a smaller id, for paging. */
  beforeId?: number;
  /** Runs to skip, for numbered pages. */
  offset?: number;
}

export interface LogQuery {
  /** Only this step's lines. */
  step?: number;
  /** Only lines with a greater id. */
  after?: number;
}

export interface PruneOptions {
  now: number;
  /** Runs finished longer ago are deleted with their steps and log. */
  historyMs?: number;
  /** Runs finished longer ago lose their log lines; the run and its steps stay. */
  logMs?: number;
}

export interface PruneResult {
  runs: number;
  logLines: number;
}

const SCHEMA_VERSION = 4;

// the log lives in its own table, without a foreign key, so it can be rotated apart from run metadata;
// a restore run has an empty cascade and its request in `restore` (JSON)
const SCHEMA = `
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  cascade TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  restore TEXT,
  rerun_of INTEGER,
  from_step INTEGER
);
CREATE INDEX runs_by_cascade ON runs (cascade, id);
CREATE TABLE steps (
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at INTEGER,
  duration_ms INTEGER,
  reason TEXT,
  stderr_tail TEXT,
  summary TEXT,
  repo TEXT,
  PRIMARY KEY (run_id, idx)
);
CREATE TABLE log (
  seq INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  step INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  stream TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX log_by_run ON log (run_id, step, seq);
`;

/** Upgrades from each older schema version to the next one. */
const MIGRATIONS: Record<number, string> = {
  1: "ALTER TABLE steps ADD COLUMN repo TEXT;",
  2: "ALTER TABLE runs ADD COLUMN restore TEXT;",
  3: "ALTER TABLE runs ADD COLUMN rerun_of INTEGER; ALTER TABLE runs ADD COLUMN from_step INTEGER;",
};

/** Run history in SQLite: runs, their steps, and step logs. */
export class Store {
  private readonly stmts: Record<
    "insertRun" | "updateRun" | "saveStep" | "appendLog" | "run" | "steps",
    StatementSync
  >;

  private constructor(private readonly db: DatabaseSync) {
    this.stmts = {
      insertRun: db.prepare(
        `INSERT INTO runs (cascade, trigger, status, reason, started_at, finished_at, restore, rerun_of, from_step)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateRun: db.prepare("UPDATE runs SET status = ?, reason = ?, finished_at = ? WHERE id = ?"),
      saveStep: db.prepare(
        `INSERT OR REPLACE INTO steps
           (run_id, idx, type, label, status, exit_code, started_at, duration_ms, reason, stderr_tail, summary, repo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      appendLog: db.prepare("INSERT INTO log (run_id, step, ts, stream, line) VALUES (?, ?, ?, ?, ?)"),
      run: db.prepare("SELECT * FROM runs WHERE id = ?"),
      steps: db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY idx"),
    };
  }

  /** Opens (and creates if needed) the database file; ":memory:" for tests. */
  static async open(file: string): Promise<Store> {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version === 0) {
        db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } else if (version > SCHEMA_VERSION) {
        throw new Error(`${file}: unsupported database schema version ${version} (expected ${SCHEMA_VERSION} or older)`);
      } else if (version < SCHEMA_VERSION) {
        const steps = Array.from({ length: SCHEMA_VERSION - version }, (_, i) => MIGRATIONS[version + i]).join(" ");
        db.exec(`BEGIN; ${steps} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      }
      return new Store(db);
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Marks runs and steps left `running` or `queued` by a daemon that did not stop cleanly as `interrupted`.
   * Returns those runs as they are now.
   */
  markInterrupted(at: number): RunRecord[] {
    const reason = "the daemon stopped during the run";
    const unfinished = "status IN ('running', 'queued')";
    this.db.prepare(`UPDATE steps SET status = 'interrupted' WHERE ${unfinished}`).run();
    return this.db
      .prepare(`UPDATE runs SET status = 'interrupted', reason = ?, finished_at = ? WHERE ${unfinished} RETURNING *`)
      .all(reason, at)
      .map(toRun)
      .sort((x, y) => x.id - y.id);
  }

  /**
   * How the latest run of the cascade before `beforeId` that got to an outcome ended
   * (`success`, `warning`, `failed` or `interrupted`; skipped and cancelled runs say nothing about the cascade).
   */
  previousOutcome(cascade: string, beforeId: number): RunState | undefined {
    const row = this.db
      .prepare(
        `SELECT status FROM runs WHERE cascade = ? AND id < ?
           AND status IN ('success', 'warning', 'failed', 'interrupted') ORDER BY id DESC LIMIT 1`,
      )
      .get(cascade, beforeId);
    return row === undefined ? undefined : (String(row.status) as RunState);
  }

  /**
   * Deletes old history. Runs in progress are never touched, nor the latest run of each cascade
   * (a cascade that runs once a month still shows its last run), nor the latest restore.
   */
  prune(opts: PruneOptions): PruneResult {
    const old = `SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?
                   AND id NOT IN (SELECT MAX(id) FROM runs GROUP BY cascade)`;
    let runs = 0;
    let logLines = 0;
    this.db.exec("BEGIN");
    try {
      if (opts.historyMs !== undefined) {
        const before = opts.now - opts.historyMs;
        logLines += Number(this.db.prepare(`DELETE FROM log WHERE run_id IN (${old})`).run(before).changes);
        runs = Number(this.db.prepare(`DELETE FROM runs WHERE id IN (${old})`).run(before).changes);
      }
      if (opts.logMs !== undefined) {
        logLines += Number(this.db.prepare(`DELETE FROM log WHERE run_id IN (${old})`).run(opts.now - opts.logMs).changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { runs, logLines };
  }

  insertRun(run: Omit<RunRecord, "id">): RunRecord {
    const r = this.stmts.insertRun.run(
      run.cascade ?? "",
      run.trigger,
      run.status,
      run.reason ?? null,
      run.startedAt,
      run.finishedAt ?? null,
      run.restore === undefined ? null : JSON.stringify(run.restore),
      run.rerunOf ?? null,
      run.fromStep ?? null,
    );
    return { id: Number(r.lastInsertRowid), ...run };
  }

  /** Sets the status, reason and finish time; an absent reason clears the old one. */
  updateRun(id: number, status: RunState, reason?: string, finishedAt?: number): void {
    this.stmts.updateRun.run(status, reason ?? null, finishedAt ?? null, id);
  }

  saveStep(s: StepRecord): void {
    this.stmts.saveStep.run(
      s.runId,
      s.index,
      s.type,
      s.label,
      s.status,
      s.exitCode ?? null,
      s.startedAt ?? null,
      s.durationMs ?? null,
      s.reason ?? null,
      s.stderrTail === undefined ? null : JSON.stringify(s.stderrTail),
      s.summary === undefined ? null : JSON.stringify(s.summary),
      s.repo ?? null,
    );
  }

  /** Returns the line with its id. */
  appendLog(runId: number, line: Omit<LogRecord, "id">): LogRecord {
    const r = this.stmts.appendLog.run(runId, line.step, line.ts, line.stream, line.line);
    return { id: Number(r.lastInsertRowid), ...line };
  }

  run(id: number): (RunRecord & { steps: StepRecord[] }) | undefined {
    const row = this.stmts.run.get(id);
    if (!row) return undefined;
    return { ...toRun(row), steps: this.stmts.steps.all(id).map(toStep) };
  }

  runs(query: RunQuery = {}): RunRecord[] {
    const { where, params } = runFilter(query);
    return this.db
      .prepare(`SELECT * FROM runs${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, query.limit ?? 50, query.offset ?? 0)
      .map(toRun);
  }

  /** How many runs match, ignoring `limit` and `offset`. */
  countRuns(query: Pick<RunQuery, "cascade" | "beforeId"> = {}): number {
    const { where, params } = runFilter(query);
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM runs${where}`).get(...params)?.n ?? 0);
  }

  /** Log lines of a run in order, or of one of its steps. */
  log(runId: number, query: LogQuery = {}): LogRecord[] {
    const where = ["run_id = ?"];
    const params: SQLInputValue[] = [runId];
    if (query.step !== undefined) {
      where.push("step = ?");
      params.push(query.step);
    }
    if (query.after !== undefined) {
      where.push("seq > ?");
      params.push(query.after);
    }
    const sql = `SELECT seq, step, ts, stream, line FROM log WHERE ${where.join(" AND ")} ORDER BY seq`;
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => ({
        id: Number(r.seq),
        step: Number(r.step),
      ts: Number(r.ts),
        stream: r.stream as LogStream,
        line: String(r.line),
      }));
  }
}

type Row = Record<string, SQLOutputValue>;

const num = (v: SQLOutputValue | undefined) => (v === null || v === undefined ? undefined : Number(v));
const str = (v: SQLOutputValue | undefined) => (v === null || v === undefined ? undefined : String(v));

function toRun(r: Row): RunRecord {
  const reason = str(r.reason);
  const finishedAt = num(r.finished_at);
  const restore = str(r.restore);
  const rerunOf = num(r.rerun_of);
  const fromStep = num(r.from_step);
  return {
    id: Number(r.id),
    ...(restore === undefined ? { cascade: String(r.cascade) } : { restore: JSON.parse(restore) as RestoreRecord }),
    trigger: r.trigger as Trigger,
    ...(rerunOf === undefined ? {} : { rerunOf }),
    ...(fromStep === undefined ? {} : { fromStep }),
    status: r.status as RunState,
    ...(reason === undefined ? {} : { reason }),
    startedAt: Number(r.started_at),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

function toStep(r: Row): StepRecord {
  const s: StepRecord = {
    runId: Number(r.run_id),
    index: Number(r.idx),
    type: r.type as StepType,
    label: String(r.label),
    status: r.status as StepState,
  };
  const exitCode = num(r.exit_code);
  const startedAt = num(r.started_at);
  const durationMs = num(r.duration_ms);
  const reason = str(r.reason);
  const tail = str(r.stderr_tail);
  const summary = str(r.summary);
  const repo = str(r.repo);
  if (repo !== undefined) s.repo = repo;
  if (exitCode !== undefined) s.exitCode = exitCode;
  if (startedAt !== undefined) s.startedAt = startedAt;
  if (durationMs !== undefined) s.durationMs = durationMs;
  if (reason !== undefined) s.reason = reason;
  if (tail !== undefined) s.stderrTail = JSON.parse(tail) as string[];
  if (summary !== undefined) s.summary = JSON.parse(summary) as Record<string, unknown>;
  return s;
}

function runFilter(query: RunQuery): { where: string; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (query.cascade !== undefined) {
    where.push("cascade = ?");
    params.push(query.cascade);
  }
  if (query.beforeId !== undefined) {
    where.push("id < ?");
    params.push(query.beforeId);
  }
  return { where: where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "", params };
}
