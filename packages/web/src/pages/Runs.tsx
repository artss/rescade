import { useLocation, useSearch } from "wouter";
import { formatDuration } from "../format.js";
import { useCascades, useRuns } from "../queries.js";
import { Badge, Button, ErrorBox, Loading, RunLink, td, th, Time } from "../components/ui.js";

export function RunsPage() {
  const cascade = new URLSearchParams(useSearch()).get("cascade") ?? undefined;
  const [, navigate] = useLocation();
  const { data: cascades } = useCascades();
  const runs = useRuns(cascade);

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        Cascade
        <select
          value={cascade ?? ""}
          onChange={(e) => navigate(e.target.value === "" ? "/runs" : `/runs?cascade=${encodeURIComponent(e.target.value)}`)}
          className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">all</option>
          {cascades?.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
          {cascade !== undefined && !cascades?.some((c) => c.name === cascade) && <option value={cascade}>{cascade}</option>}
        </select>
      </label>

      {runs.error && <ErrorBox error={runs.error} />}
      {!runs.data && !runs.error && <Loading />}
      {runs.data && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className={th}>Run</th>
                <th className={th}>Cascade</th>
                <th className={th}>Trigger</th>
                <th className={th}>Status</th>
                <th className={th}>Started</th>
                <th className={th}>Took</th>
                <th className={th}>Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {runs.data.pages.flat().map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <RunLink id={r.id}>{r.id}</RunLink>
                  </td>
                  <td className={td}>{r.cascade}</td>
                  <td className={td}>{r.trigger}</td>
                  <td className={td}>
                    <Badge status={r.status} />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <Time ms={r.startedAt} />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    {r.finishedAt === undefined ? "-" : formatDuration(r.finishedAt - r.startedAt)}
                  </td>
                  <td className={`${td} text-zinc-500`}>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.data.pages[0]?.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">No runs yet.</p>}
        </div>
      )}
      {runs.hasNextPage && (
        <Button onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  );
}
