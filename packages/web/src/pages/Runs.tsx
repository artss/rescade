import { mdiChevronLeft, mdiChevronRight } from "@mdi/js";
import { useLocation, useSearch } from "wouter";
import { formatDuration } from "../format.js";
import { pageRange, parsePage, RUNS_PAGE } from "../paging.js";
import { useCascades, useRuns } from "../queries.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { Icon } from "../components/Icon.js";
import { Loading } from "../components/Loading.js";
import { RunLink } from "../components/RunLink.js";
import { Time } from "../components/Time.js";
import { td, th } from "../components/table.js";

export function RunsPage() {
  const search = new URLSearchParams(useSearch());
  const cascade = search.get("cascade") ?? undefined;
  const page = parsePage(search.get("page"));
  const [, navigate] = useLocation();
  const { data: cascades } = useCascades();
  const runs = useRuns(cascade, page);
  const go = (cascade: string | undefined, page: number) => {
    const params = new URLSearchParams();
    if (cascade !== undefined) params.set("cascade", cascade);
    if (page > 1) params.set("page", String(page));
    navigate(params.size > 0 ? `/runs?${params}` : "/runs");
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        Cascade
        <select
          value={cascade ?? ""}
          onChange={(e) => go(e.target.value === "" ? undefined : e.target.value, 1)}
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
              {runs.data.runs.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <RunLink id={r.id}>{r.id}</RunLink>
                  </td>
                  <td className={td}>{r.cascade ?? "restore"}</td>
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
          {runs.data.runs.length === 0 && (
            <p className="px-3 py-4 text-sm text-zinc-500">{runs.data.total === 0 ? "No runs yet." : "No runs on this page."}</p>
          )}
        </div>
      )}
      {runs.data && (runs.data.total > RUNS_PAGE || page > 1) && (
        <Pager page={page} total={runs.data.total} onPage={(p) => {
            go(cascade, p);
            window.scrollTo({ top: 0 });
          }} busy={runs.isPlaceholderData} />
      )}
    </div>
  );
}

function Pager({ page, total, onPage, busy }: { page: number; total: number; onPage: (page: number) => void; busy: boolean }) {
  const { from, to, pages } = pageRange(page, total, RUNS_PAGE);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-3 text-sm">
      <Button icon={mdiChevronLeft} onClick={() => onPage(Math.min(page - 1, pages))} disabled={page === 1 || busy}>
        Newer
      </Button>
      <span className="text-zinc-500">
        {from <= to ? `${from}–${to} of ${total}` : `${total} in all`}, page {page} of {pages}
      </span>
      <Button onClick={() => onPage(page + 1)} disabled={page >= pages || busy}>
        Older
        <Icon path={mdiChevronRight} />
      </Button>
    </nav>
  );
}
