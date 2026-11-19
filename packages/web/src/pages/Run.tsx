import { mdiChevronRight, mdiCloseCircleOutline, mdiPlayOutline } from "@mdi/js";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { formatBytes, formatDuration } from "../format.js";
import { canRerun, isActive, useCancelRun, useLog, useRerun, useRun } from "../queries.js";
import { openByDefault } from "../steps.js";
import type { LogRecord, StepRecord } from "../types.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { Icon } from "../components/Icon.js";
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
              <Link href={`/runs?cascade=${encodeURIComponent(run.cascade)}`} className="text-accent hover:underline">
                {run.cascade}
              </Link>
            )}
          </h1>
          <Badge status={run.status} />
          <span className="text-sm text-zinc-500">{run.trigger}</span>
          {active && (
            <span className="ml-auto">
              <Button
                danger
                icon={mdiCloseCircleOutline}
                onClick={() => {
                  if (confirm(`Cancel run ${run.id}? The current step will be stopped.`)) cancel.mutate(run.id);
                }}
                disabled={cancel.isPending || cancel.isSuccess}>
                {cancel.isSuccess ? "Cancelling…" : "Cancel"}
              </Button>
            </span>
          )}
          {canRerun(run) && (
            <span className="ml-auto">
              <Button
                icon={mdiPlayOutline}
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
            <Link href={`/runs/${run.rerunOf}`} className="text-accent hover:underline">
              run {run.rerunOf}
            </Link>
            {(run.fromStep ?? 0) > 0 && <>: {run.fromStep === 1 ? "step 1 was" : `steps 1–${run.fromStep} were`} done there</>}
          </p>
        )}
        {cancel.error && <div className="mt-2"><ErrorBox error={cancel.error} /></div>}
        {rerun.error && <div className="mt-2"><ErrorBox error={rerun.error} /></div>}
      </Card>

      <Steps runId={run.id} steps={run.steps} />
    </div>
  );
}

/** The steps of a run, each with its own part of the log. */
function Steps({ runId, steps }: { runId: number; steps: StepRecord[] }) {
  const { data, error } = useLog(runId);
  const byStep = new Map<number, LogRecord[]>();
  for (const l of data?.lines ?? []) {
    const have = byStep.get(l.step);
    if (have) have.push(l);
    else byStep.set(l.step, [l]);
  }
  return (
    <>
      {error && <ErrorBox error={error} />}
      <ol className="space-y-2">
        {steps.map((s) => (
          <StepItem key={s.index} step={s} lines={byStep.get(s.index) ?? []} logComplete={data?.complete ?? false} />
        ))}
      </ol>
    </>
  );
}

/**
 * A step with its log. Finished successful steps start folded, the rest open; a click on the header
 * folds or unfolds it until the step changes state again.
 */
function StepItem({ step: s, lines, logComplete }: { step: StepRecord; lines: LogRecord[]; logComplete: boolean }) {
  const [choice, setChoice] = useState<{ status: string; open: boolean }>();
  const open = choice?.status === s.status ? choice.open : openByDefault(s.status);
  const bodyId = `step-${s.index}`;
  return (
    <li className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setChoice({ status: s.status, open: !open })}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm"
      >
        <Icon path={mdiChevronRight} className={`size-4 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="text-zinc-500">{s.index + 1}.</span>
        <span className="font-mono">{s.label}</span>
        <Badge status={s.status} />
        {s.exitCode !== undefined && <span className="text-zinc-500">exit {s.exitCode}</span>}
        {s.durationMs !== undefined && <span className="text-zinc-500">{formatDuration(s.durationMs)}</span>}
      </button>
      {open && (
        <div id={bodyId} className="space-y-2 px-4 pb-3">
          {s.reason && <p className="text-sm">{s.reason}</p>}
          {s.summary && <Summary summary={s.summary} repo={s.repo} />}
          {lines.length > 0 ? (
            <StepLog index={s.index} lines={lines} follow={s.status === "running"} />
          ) : s.stderrTail && s.stderrTail.length > 0 ? (
            // the log of an old run may be deleted, the tail of stderr stays with the step
            <pre className="overflow-x-auto rounded bg-zinc-100 p-2 text-xs text-red-800 dark:bg-zinc-950 dark:text-red-300">
              {s.stderrTail.join("\n")}
            </pre>
          ) : !logComplete ? (
            <Loading />
          ) : (
            s.status !== "queued" &&
            s.status !== "running" && <p className="text-sm text-zinc-500">No log lines (logs of old runs are deleted after a while).</p>
          )}
        </div>
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
                <Link href={snapshotHref(repo, v)} className="text-accent hover:underline">
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

/** A step's log; while the step runs it keeps to the bottom unless scrolled up. */
function StepLog({ index, lines, follow }: { index: number; lines: LogRecord[]; follow: boolean }) {
  const box = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    if (follow && atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  return (
    <pre
      ref={box}
      data-testid={`log-${index}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-[32rem] overflow-auto rounded bg-zinc-100 p-3 text-xs leading-5 dark:bg-zinc-950"
    >
      {lines.map((l) => (
        <div key={l.id} className={streamClass[l.stream]}>
          {l.line}
        </div>
      ))}
    </pre>
  );
}
