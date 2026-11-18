import { Link } from "wouter";
import { formatBytes } from "../format.js";
import { useRepos, useSnapshotDir, useSnapshots } from "../queries.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { Loading } from "../components/Loading.js";
import { RepoCard, repoHref, StaleLocksNote } from "../components/RepoCard.js";
import { SnapshotTree } from "../components/SnapshotTree.js";
import { Time } from "../components/Time.js";
import { td, th } from "../components/table.js";

const link = "text-accent hover:underline";

export const snapshotHref = (repo: string, id: string) => `${repoHref(repo)}/snapshots/${encodeURIComponent(id)}`;

/** A repo: its state and its snapshots. */
export function RepoPage({ repo }: { repo: string }) {
  const repos = useRepos();
  const view = repos.data?.find((r) => r.name === repo);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">
        <Link href="/repos" className={link}>
          Repos
        </Link>{" "}
        / {repo}
      </h1>
      {repos.error && <ErrorBox error={repos.error} />}
      {!repos.data && !repos.error && <Loading />}
      {repos.data && !view && <p className="text-sm text-zinc-500">No such repo.</p>}
      {view && (
        <>
          <RepoCard repo={view} detailed />
          <StaleLocksNote repos={[view]} />
          <h2 className="font-semibold">Snapshots</h2>
          <Snapshots repo={repo} />
        </>
      )}
    </div>
  );
}

/** The snapshots of a repo, newest first. */
function Snapshots({ repo }: { repo: string }) {
  const { data, error } = useSnapshots(repo);
  return (
    <>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Loading />}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className={th}>ID</th>
                <th className={th}>Time</th>
                <th className={th}>Host</th>
                <th className={th}>Paths</th>
                <th className={th}>Tags</th>
                <th className={`${th} text-right`}>Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.map((s) => (
                <tr key={s.id}>
                  <td className={`${td} font-mono`}>
                    <Link href={snapshotHref(repo, s.id)} className={link}>
                      {s.shortId}
                    </Link>
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <Time ms={s.time} />
                  </td>
                  <td className={td}>{s.hostname}</td>
                  <td className={`${td} break-all font-mono text-xs`}>{s.paths.join(" ")}</td>
                  <td className={td}>{s.tags.join(", ")}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>{s.size === undefined ? "-" : formatBytes(s.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">No snapshots yet.</p>}
        </div>
      )}
    </>
  );
}

/** A snapshot: its files as a tree, to pick what to restore. */
export function SnapshotPage({ repo, id }: { repo: string; id: string }) {
  const { data, error } = useSnapshotDir(repo, id, "/");

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">
        <Link href="/repos" className={link}>
          Repos
        </Link>{" "}
        /{" "}
        <Link href={repoHref(repo)} className={link}>
          {repo}
        </Link>{" "}
        / <span className="font-mono">{data?.snapshot.shortId ?? id.slice(0, 8)}</span>
      </h1>
      {data && (
        <p className="text-sm text-zinc-500">
          <Time ms={data.snapshot.time} /> on {data.snapshot.hostname}
          {data.snapshot.tags.length > 0 && <>, tags {data.snapshot.tags.join(", ")}</>}
          {data.snapshot.size !== undefined && <>, {formatBytes(data.snapshot.size)}</>}
        </p>
      )}
      {error && <ErrorBox error={error} />}
      {!data && !error && <Loading />}
      {data && <SnapshotTree repo={repo} snapshot={data.snapshot} />}
    </div>
  );
}
