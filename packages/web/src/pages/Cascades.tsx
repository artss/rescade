import { useState } from "react";
import { useLocation } from "wouter";
import { formatDuration } from "../format.js";
import { useCascades, useStartRun } from "../queries.js";
import type { CascadeView } from "../types.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { Loading } from "../components/Loading.js";
import { RunLink } from "../components/RunLink.js";
import { Time } from "../components/Time.js";

export function CascadesPage() {
  const { data, error } = useCascades();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (data.length === 0) return <p className="text-sm text-zinc-500">The config has no cascades.</p>;
  return (
    <div className="grid gap-3">
      {data.map((c) => (
        <CascadeCard key={c.name} cascade={c} />
      ))}
    </div>
  );
}

function CascadeCard({ cascade: c }: { cascade: CascadeView }) {
  const start = useStartRun();
  const [, navigate] = useLocation();
  const [skipped, setSkipped] = useState<string>();
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
          <h2 className="font-semibold">{c.name}</h2>
          {c.description && <p className="text-sm text-zinc-500">{c.description}</p>}
        </div>
        <Button onClick={run} disabled={start.isPending || c.active !== null} aria-label={`Run ${c.name}`}>
          Run
        </Button>
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

      <ol className="mt-3 flex flex-wrap gap-1.5">
        {c.steps.map((s, i) => (
          <li key={i} className="rounded bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800">
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>
    </Card>
  );
}
