import { Link } from "wouter";
import type { RepoView } from "../types.js";
import { Badge } from "./Badge.js";
import { Card } from "./Card.js";
import { RunLink } from "./RunLink.js";
import { Time } from "./Time.js";

export const repoHref = (repo: string) => `/repos/${encodeURIComponent(repo)}`;

/**
 * The state of a repo. In the list the name links to the repo page; on that page the name is in the heading
 * and the card adds what restic knows about the repo.
 */
export function RepoCard({ repo: r, detailed = false }: { repo: RepoView; detailed?: boolean }) {
  const unread = r.locks ? r.locks.count - r.locks.locks.length : 0;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        {!detailed && (
          <h2 className="font-semibold">
            <Link href={repoHref(r.name)} className="text-accent hover:underline">
              {r.name}
            </Link>
          </h2>
        )}
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
            <dd>
              <Link href={repoHref(r.from)} className="text-accent hover:underline">
                {r.from}
              </Link>
            </dd>
          </>
        )}
        {detailed && (
          <>
            <dt className="text-zinc-500">ID</dt>
            <dd className="break-all font-mono text-xs leading-5">{r.id ?? <span className="text-zinc-400">-</span>}</dd>
            <dt className="text-zinc-500">Chunker polynomial</dt>
            <dd className="font-mono text-xs leading-5">{r.chunkerPolynomial ?? <span className="text-zinc-400">-</span>}</dd>
          </>
        )}
        <dt className="text-zinc-500">Held by</dt>
        <dd>
          {r.lockedBy ? (
            <>
              <RunLink id={r.lockedBy.runId} /> ({r.lockedBy.cascade ?? "restore"})
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

/** Shown under repos that have stale restic locks. */
export function StaleLocksNote({ repos }: { repos: RepoView[] }) {
  if (!repos.some((r) => r.locks?.locks.some((l) => l.stale))) return null;
  return (
    <p className="text-sm text-zinc-500">
      Stale locks are left by restic that did not finish. Check that nothing uses the repo, then run{" "}
      <code className="font-mono">restic unlock</code>.
    </p>
  );
}
