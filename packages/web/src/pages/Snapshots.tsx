import { Link, useSearch } from "wouter";
import { formatBytes } from "../format.js";
import { useSnapshotDir, useSnapshots } from "../queries.js";
import type { SnapshotEntry } from "../types.js";
import { Card } from "../components/Card.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { Loading } from "../components/Loading.js";
import { Time } from "../components/Time.js";
import { td, th } from "../components/table.js";

const link = "text-sky-700 hover:underline dark:text-sky-400";

export const snapshotsHref = (repo: string) => `/repos/${encodeURIComponent(repo)}/snapshots`;
export const snapshotHref = (repo: string, id: string, path?: string) =>
  `${snapshotsHref(repo)}/${encodeURIComponent(id)}${path === undefined || path === "/" ? "" : `?${new URLSearchParams({ path })}`}`;

/** The snapshots of a repo, newest first. */
export function SnapshotsPage({ repo }: { repo: string }) {
  const { data, error } = useSnapshots(repo);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">
        <Link href="/repos" className={link}>
          Repos
        </Link>{" "}
        / {repo} / snapshots
      </h1>
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
    </div>
  );
}

/** One directory of a snapshot at a time; the path is in `?path=`. */
export function SnapshotPage({ repo, id }: { repo: string; id: string }) {
  const path = new URLSearchParams(useSearch()).get("path") || "/";
  const { data, error } = useSnapshotDir(repo, id, path);
  const parts = path.split("/").filter(Boolean);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">
        <Link href="/repos" className={link}>
          Repos
        </Link>{" "}
        /{" "}
        <Link href={snapshotsHref(repo)} className={link}>
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

      <nav aria-label="Path" className="break-all font-mono text-sm">
        <Link href={snapshotHref(repo, id)} className={link}>
          /
        </Link>
        {parts.map((part, i) => {
          const to = `/${parts.slice(0, i + 1).join("/")}`;
          return (
            <span key={to}>
              {i > 0 && "/"}
              {i === parts.length - 1 ? (
                <span>{part}</span>
              ) : (
                <Link href={snapshotHref(repo, id, to)} className={link}>
                  {part}
                </Link>
              )}
            </span>
          );
        })}
      </nav>

      {error && <ErrorBox error={error} />}
      {!data && !error && <Loading />}
      {data && (
        <Card>
          {data.entries.length === 0 ? (
            <p className="text-sm text-zinc-500">Empty directory.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {sorted(data.entries).map((e) => (
                  <tr key={e.path}>
                    <td className="py-1 pr-3 font-mono text-xs text-zinc-500">{e.permissions}</td>
                    <td className="break-all py-1 pr-3 font-mono">
                      {e.type === "dir" && e.path !== data.path ? (
                        <Link href={snapshotHref(repo, id, e.path)} className={link}>
                          {e.name}/
                        </Link>
                      ) : (
                        e.name
                      )}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3 text-right">{e.size === undefined ? "" : formatBytes(e.size)}</td>
                    <td className="whitespace-nowrap py-1 text-zinc-500">
                      <Time ms={e.mtime} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.truncated && (
            <p className="mt-2 text-sm text-zinc-500">Only the first {data.entries.length} entries are shown.</p>
          )}
        </Card>
      )}
    </div>
  );
}

/** Directories first, then by name. */
function sorted(entries: SnapshotEntry[]): SnapshotEntry[] {
  return [...entries].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
}
