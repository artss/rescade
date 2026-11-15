import { useRepos } from "../queries.js";
import type { RepoView } from "../types.js";
import { Badge } from "../components/Badge.js";
import { Card } from "../components/Card.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { Loading } from "../components/Loading.js";
import { RunLink } from "../components/RunLink.js";
import { Time } from "../components/Time.js";

export function ReposPage() {
  const { data, error } = useRepos();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const stale = data.some((r) => r.locks?.locks.some((l) => l.stale));
  return (
    <div className="space-y-3">
      {data.map((r) => (
        <RepoCard key={r.name} repo={r} />
      ))}
      {stale && (
        <p className="text-sm text-zinc-500">
          Stale locks are left by restic that did not finish. Check that nothing uses the repo, then run{" "}
          <code className="font-mono">restic unlock</code>.
        </p>
      )}
    </div>
  );
}

function RepoCard({ repo: r }: { repo: RepoView }) {
  const unread = r.locks ? r.locks.count - r.locks.locks.length : 0;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">{r.name}</h2>
        <Badge status={r.state} />
        <span className="break-all font-mono text-xs text-zinc-500">{r.location}</span>
      </div>
      {r.reason && <p className="mt-1 text-sm">{r.reason}</p>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">Checked</dt>
        <dd>
          <Time ms={r.checkedAt} />
        </dd>
        {r.from && (
          <>
            <dt className="text-zinc-500">Created from</dt>
            <dd>{r.from}</dd>
          </>
        )}
        <dt className="text-zinc-500">Held by</dt>
        <dd>
          {r.lockedBy ? (
            <>
              <RunLink id={r.lockedBy.runId} /> ({r.lockedBy.cascade})
            </>
          ) : (
            <span className="text-zinc-400">-</span>
          )}
        </dd>
        <dt className="text-zinc-500">restic locks</dt>
        <dd>{r.locks ? r.locks.count : <span className="text-zinc-400">-</span>}</dd>
      </dl>
      {r.locks && r.locks.locks.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {r.locks.locks.map((l) => (
            <li key={l.id} className={l.stale ? "text-amber-700 dark:text-amber-400" : "text-zinc-600 dark:text-zinc-400"}>
              <span className="font-mono">{l.id.slice(0, 8)}</span> {l.exclusive ? "exclusive" : "shared"}
              {l.stale && ", stale"} by {l.username}@{l.hostname} pid {l.pid} at <Time ms={l.time} />
            </li>
          ))}
        </ul>
      )}
      {unread > 0 && r.locks?.error === undefined && <p className="mt-1 text-xs text-zinc-500">{unread} more locks</p>}
      {r.locks?.error && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{r.locks.error}</p>}
    </Card>
  );
}
