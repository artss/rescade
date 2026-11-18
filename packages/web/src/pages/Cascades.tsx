import { useId, useState } from "react";
import { Link, useLocation } from "wouter";
import { formatDuration } from "../format.js";
import { useCascades, useStartRun } from "../queries.js";
import { stepDetails } from "../steps.js";
import type { CascadeStep, CascadeView } from "../types.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { GroupedList } from "../components/Group.js";
import { Loading } from "../components/Loading.js";
import { RunLink } from "../components/RunLink.js";
import { Time } from "../components/Time.js";

export function CascadesPage() {
  const { data, error } = useCascades();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (data.length === 0) return <p className="text-sm text-zinc-500">The config has no cascades.</p>;
  return <GroupedList list="cascades" items={data} groupOf={(c) => c.group} keyOf={(c) => c.name} render={(c) => <CascadeCard cascade={c} />} />;
}

function CascadeCard({ cascade: c }: { cascade: CascadeView }) {
  const start = useStartRun();
  const [, navigate] = useLocation();
  const [skipped, setSkipped] = useState<string>();
  const [stepsOpen, setStepsOpen] = useState(false);
  const stepsId = useId();
  const run = () => {
    setSkipped(undefined);
    start.mutate(c.name, {
      onSuccess: (r) => (r.status === "skipped" ? setSkipped(r.reason ?? "skipped") : navigate(`/runs/${r.id}`)),
    });
  };
  const busy = c.onBusy === "wait" ? `wait${c.waitTimeoutMs === null ? "" : ` up to ${formatDuration(c.waitTimeoutMs)}`}` : "skip";

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            <Link href={`/runs?${new URLSearchParams({ cascade: c.name })}`} className="text-sky-700 hover:underline dark:text-sky-400">
              {c.name}
            </Link>
          </h2>
          {c.description && <p className="text-sm text-zinc-500">{c.description}</p>}
        </div>
        {c.active ? (
          <Link
            href={`/runs/${c.active.id}`}
            aria-label={`Running ${c.name}`}
            className="rounded border border-sky-600 px-3 py-1 text-sm font-medium text-sky-700 hover:bg-sky-50 dark:border-sky-400 dark:text-sky-400 dark:hover:bg-sky-950"
          >
            Running
          </Link>
        ) : (
          <Button onClick={run} disabled={start.isPending} aria-label={`Run ${c.name}`}>
            Run
          </Button>
        )}
      </div>
      {start.error && <div className="mt-2"><ErrorBox error={start.error} /></div>}
      {skipped && <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">Skipped: {skipped}</p>}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
        <dt className="text-zinc-500">Schedule</dt>
        <dd className="font-mono text-xs leading-5">
          {c.schedule.length === 0 ? <span className="font-sans text-zinc-500">manual only</span> : c.schedule.join(", ")}
          {c.timezone && <span className="font-sans text-zinc-500"> ({c.timezone})</span>}
        </dd>
        <dt className="text-zinc-500">Next run</dt>
        <dd>
          <Time ms={c.nextRun} />
        </dd>
        <dt className="text-zinc-500">Last run</dt>
        <dd>
          {c.lastRun ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge status={c.lastRun.status} /> <Time ms={c.lastRun.startedAt} /> <RunLink id={c.lastRun.id} />
            </span>
          ) : (
            <span className="text-zinc-400">never</span>
          )}
        </dd>
        <dt className="text-zinc-500">When busy</dt>
        <dd>{busy}</dd>
        {c.active && (
          <>
            <dt className="text-zinc-500">Now</dt>
            <dd className="flex items-center gap-2">
              <Badge status={c.active.status} /> <RunLink id={c.active.id} />
              {c.active.reason && <span className="text-zinc-500">{c.active.reason}</span>}
            </dd>
          </>
        )}
      </dl>

      <button
        type="button"
        aria-expanded={stepsOpen}
        aria-controls={stepsId}
        aria-label={`Steps of ${c.name}`}
        onClick={() => setStepsOpen(!stepsOpen)}
        className="mt-3 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <span aria-hidden className={`inline-block transition-transform ${stepsOpen ? "rotate-90" : ""}`}>
          ▸
        </span>
        Steps ({c.steps.length})
      </button>
      {stepsOpen && (
        <ol id={stepsId} className="mt-2 grid gap-1.5" aria-label={`Steps of ${c.name}`}>
          {c.steps.map((s, i) => (
            <StepItem key={i} index={i} step={s} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function StepItem({ index, step }: { index: number; step: CascadeStep }) {
  const details = stepDetails(step);
  return (
    <li className="rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
      <span className="font-mono">
        {index + 1}. {step.label}
      </span>
      {details.length > 0 && (
        <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 pl-4">
          {details.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-zinc-500">{term}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
