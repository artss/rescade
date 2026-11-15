import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import type { Step } from "../config/types.js";
import type { LogStream, RunStatus, StepStatus } from "../run/cascade.js";

export type Trigger = "schedule" | "manual";

/** `queued`: a step waits for busy repos (`on-busy: wait`). `interrupted`: the daemon stopped during the run. */
export type RunState = "queued" | "running" | RunStatus | "interrupted";
export type StepState = "queued" | "running" | StepStatus | "interrupted";

export interface RunRecord {
  id: number;
  cascade: string;
  trigger: Trigger;
  status: RunState;
  reason?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  finishedAt?: number;
}

export interface StepRecord {
  runId: number;
  index: number;
  type: Step["type"];
  label: string;
  status: StepState;
  exitCode?: number;
  startedAt?: number;
  durationMs?: number;
  reason?: string;
  stderrTail?: string[];
  summary?: Record<string, unknown>;
}

export interface LogRecord {
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
}

const SCHEMA_VERSION = 1;

// the log lives in its own table, without a foreign key, so it can be rotated apart from run metadata
const SCHEMA = `
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  cascade TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
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

/** Run history in SQLite: runs, their steps, and step logs. */
export class Store {
  private readonly stmts: Record<
    "insertRun" | "updateRun" | "saveStep" | "appendLog" | "run" | "steps" | "log" | "stepLog",
    StatementSync
  >;

  private constructor(private readonly db: DatabaseSync) {
    this.stmts = {
      insertRun: db.prepare(
        "INSERT INTO runs (cascade, trigger, status, reason, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      updateRun: db.prepare("UPDATE runs SET status = ?, reason = ?, finished_at = ? WHERE id = ?"),
      saveStep: db.prepare(
        `INSERT OR REPLACE INTO steps
           (run_id, idx, type, label, status, exit_code, started_at, duration_ms, reason, stderr_tail, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      appendLog: db.prepare("INSERT INTO log (run_id, step, ts, stream, line) VALUES (?, ?, ?, ?, ?)"),
      run: db.prepare("SELECT * FROM runs WHERE id = ?"),
      steps: db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY idx"),
      log: db.prepare("SELECT step, ts, stream, line FROM log WHERE run_id = ? ORDER BY seq"),
      stepLog: db.prepare("SELECT step, ts, stream, line FROM log WHERE run_id = ? AND step = ? ORDER BY seq"),
    };
  }

  /**
   * Opens (and creates if needed) the database file; ":memory:" for tests.
   * node:sqlite is loaded here, not at import time: on Node 22 loading it prints an ExperimentalWarning.
   */
  static async open(file: string): Promise<Store> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version === 0) {
        db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(`${file}: unsupported database schema version ${version} (expected ${SCHEMA_VERSION})`);
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

  insertRun(run: Omit<RunRecord, "id">): RunRecord {
    const r = this.stmts.insertRun.run(
      run.cascade,
      run.trigger,
      run.status,
      run.reason ?? null,
      run.startedAt,
      run.finishedAt ?? null,
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
    );
  }

  appendLog(runId: number, line: LogRecord): void {
    this.stmts.appendLog.run(runId, line.step, line.ts, line.stream, line.line);
  }

  run(id: number): (RunRecord & { steps: StepRecord[] }) | undefined {
    const row = this.stmts.run.get(id);
    if (!row) return undefined;
    return { ...toRun(row), steps: this.stmts.steps.all(id).map(toStep) };
  }

  runs(query: RunQuery = {}): RunRecord[] {
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
    const sql =
      "SELECT * FROM runs" + (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY id DESC LIMIT ?";
    return this.db
      .prepare(sql)
      .all(...params, query.limit ?? 50)
      .map(toRun);
  }

  /** Log lines of a run, or of one of its steps. */
  log(runId: number, step?: number): LogRecord[] {
    const rows = step === undefined ? this.stmts.log.all(runId) : this.stmts.stepLog.all(runId, step);
    return rows.map((r) => ({
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
  return {
    id: Number(r.id),
    cascade: String(r.cascade),
    trigger: r.trigger as Trigger,
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
    type: r.type as Step["type"],
    label: String(r.label),
    status: r.status as StepState,
  };
  const exitCode = num(r.exit_code);
  const startedAt = num(r.started_at);
  const durationMs = num(r.duration_ms);
  const reason = str(r.reason);
  const tail = str(r.stderr_tail);
  const summary = str(r.summary);
  if (exitCode !== undefined) s.exitCode = exitCode;
  if (startedAt !== undefined) s.startedAt = startedAt;
  if (durationMs !== undefined) s.durationMs = durationMs;
  if (reason !== undefined) s.reason = reason;
  if (tail !== undefined) s.stderrTail = JSON.parse(tail) as string[];
  if (summary !== undefined) s.summary = JSON.parse(summary) as Record<string, unknown>;
  return s;
}
