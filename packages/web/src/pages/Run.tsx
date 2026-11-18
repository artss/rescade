import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { formatBytes, formatDuration } from "../format.js";
import { canRerun, isActive, useCancelRun, useLog, useRerun, useRun } from "../queries.js";
import type { LogRecord, StepRecord } from "../types.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { Loading } from "../components/Loading.js";
import { Time } from "../components/Time.js";
import { snapshotHref } from "./Repo.js";

export function RunPage({ id }: { id: number }) {
  const { data: run, error } = useRun(id);
  const cancel = useCancelRun();
  const rerun = useRerun();
  const [, navigate] = useLocation();
  if (error) return <ErrorBox error={error} />;
  if (!run) return <Loading />;
  const active = isActive(run.status);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">
            Run {run.id} of{" "}
            {run.cascade === undefined ? (
              "restore"
            ) : (
              <Link href={`/runs?cascade=${encodeURIComponent(run.cascade)}`} className="text-sky-700 hover:underline dark:text-sky-400">
                {run.cascade}
              </Link>
            )}
          </h1>
          <Badge status={run.status} />
          <span className="text-sm text-zinc-500">{run.trigger}</span>
          {active && (
            <span className="ml-auto">
              <Button danger onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending || cancel.isSuccess}>
                {cancel.isSuccess ? "Cancelling…" : "Cancel"}
              </Button>
            </span>
          )}
          {canRerun(run) && (
            <span className="ml-auto">
              <Button
                onClick={() => rerun.mutate(run.id, { onSuccess: (r) => navigate(`/runs/${r.id}`) })}
                disabled={rerun.isPending}
              >
                Rerun from failed
              </Button>
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Started <Time ms={run.startedAt} />
          {run.finishedAt !== undefined && <>, took {formatDuration(run.finishedAt - run.startedAt)}</>}
        </p>
        {run.reason && <p className="mt-2 text-sm">{run.reason}</p>}
        {run.rerunOf !== undefined && (
          <p className="mt-2 text-sm text-zinc-500">
            Rerun of{" "}
            <Link href={`/runs/${run.rerunOf}`} className="text-sky-700 hover:underline dark:text-sky-400">
              run {run.rerunOf}
            </Link>
            {(run.fromStep ?? 0) > 0 && <>: {run.fromStep === 1 ? "step 1 was" : `steps 1–${run.fromStep} were`} done there</>}
          </p>
        )}
        {cancel.error && <div className="mt-2"><ErrorBox error={cancel.error} /></div>}
        {rerun.error && <div className="mt-2"><ErrorBox error={rerun.error} /></div>}
      </Card>

      <ol className="space-y-2">
        {run.steps.map((s) => (
          <StepItem key={s.index} step={s} />
        ))}
      </ol>

      <LogView runId={run.id} steps={run.steps} follow={active} />
    </div>
  );
}

function StepItem({ step: s }: { step: StepRecord }) {
  return (
    <li className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-zinc-500">{s.index + 1}.</span>
        <span className="font-mono">{s.label}</span>
        <Badge status={s.status} />
        {s.exitCode !== undefined && <span className="text-zinc-500">exit {s.exitCode}</span>}
        {s.durationMs !== undefined && <span className="text-zinc-500">{formatDuration(s.durationMs)}</span>}
      </div>
      {s.reason && <p className="mt-1 text-sm">{s.reason}</p>}
      {s.summary && <Summary summary={s.summary} repo={s.repo} />}
      {s.stderrTail && s.stderrTail.length > 0 && (
        <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-2 text-xs text-red-800 dark:bg-zinc-950 dark:text-red-300">
          {s.stderrTail.join("\n")}
        </pre>
      )}
    </li>
  );
}

/** restic's backup summary; sizes in bytes and times in seconds are made readable. */
function Summary({ summary, repo }: { summary: Record<string, unknown>; repo?: string }) {
  const show = (key: string, v: unknown): string => {
    if (typeof v === "number" && (key.includes("bytes") || key === "data_added" || key === "data_added_packed")) return formatBytes(v);
    if (typeof v === "number" && key === "total_duration") return formatDuration(v * 1000);
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
      {Object.entries(summary)
        .filter(([key]) => key !== "message_type")
        .map(([key, v]) => (
          <div key={key} className="contents">
            <dt className="text-zinc-500">{key.replaceAll("_", " ")}</dt>
            <dd className="font-mono">
              {key === "snapshot_id" && typeof v === "string" && repo !== undefined ? (
                <Link href={snapshotHref(repo, v)} className="text-sky-700 hover:underline dark:text-sky-400">
                  {v.slice(0, 8)}
                </Link>
              ) : (
                show(key, v)
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}

const streamClass: Record<LogRecord["stream"], string> = {
  stdout: "",
  stderr: "text-red-700 dark:text-red-400",
  info: "text-zinc-500 italic",
};

/** The run's log, all steps or one; while the run goes on it keeps to the bottom unless scrolled up. */
function LogView({ runId, steps, follow }: { runId: number; steps: StepRecord[]; follow: boolean }) {
  const { data, error } = useLog(runId);
  const [step, setStep] = useState<number>();
  const box = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    if (follow && atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data, follow, step]);

  const lines = (data?.lines ?? []).filter((l) => step === undefined || l.step === step);
  const label = (index: number) => steps.find((s) => s.index === index)?.label ?? "";
  const rows: React.ReactNode[] = [];
  let current: number | undefined;
  for (const l of lines) {
    if (step === undefined && l.step !== current) {
      rows.push(
        <div key={`step-${l.id}`} className="mt-2 font-semibold text-zinc-600 first:mt-0 dark:text-zinc-300">
          ==&gt; [{l.step + 1}] {label(l.step)}
        </div>,
      );
    }
    current = l.step;
    rows.push(
      <div key={l.id} className={streamClass[l.stream]}>
        {l.line}
      </div>,
    );
  }

  return (
    <Card>
      <div className="mb-2 flex items-center gap-3">
        <h2 className="font-semibold">Log</h2>
        <select
          aria-label="Step"
          value={step ?? ""}
          onChange={(e) => setStep(e.target.value === "" ? undefined : Number(e.target.value))}
          className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">all steps</option>
          {steps.map((s) => (
            <option key={s.index} value={s.index}>
              {s.index + 1}. {s.label}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorBox error={error} />}
      {!data?.complete && !error && <Loading />}
      {data?.complete && lines.length === 0 && (
        <p className="text-sm text-zinc-500">No log lines (logs of old runs are deleted after a while).</p>
      )}
      {lines.length > 0 && (
        <pre
          ref={box}
          data-testid="log"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="max-h-[32rem] overflow-auto rounded bg-zinc-100 p-3 text-xs leading-5 dark:bg-zinc-950"
        >
          {rows}
        </pre>
      )}
    </Card>
  );
}
