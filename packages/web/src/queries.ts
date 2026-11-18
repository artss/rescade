import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { request, send } from "./api.js";
import { mergeLog, type LogData } from "./log.js";
import { RUNS_PAGE } from "./paging.js";
import type {
  CascadeView,
  DaemonStatus,
  LogRecord,
  RepoView,
  RunRecord,
  RunWithSteps,
  ServerEvent,
  Snapshot,
  SnapshotDir,
  StepRecord,
} from "./types.js";

export const keys = {
  status: ["status"] as const,
  cascades: ["cascades"] as const,
  runs: (cascade: string | undefined, page: number) => ["runs", cascade ?? null, page] as const,
  allRuns: ["runs"] as const,
  run: (id: number) => ["run", id] as const,
  log: (id: number) => ["log", id] as const,
  repos: ["repos"] as const,
  snapshots: (repo: string) => ["snapshots", repo] as const,
  allSnapshots: ["snapshots"] as const,
  snapshotDir: (repo: string, id: string, path: string) => ["snapshot-dir", repo, id, path] as const,
};

export const isActive = (status: RunRecord["status"]) => status === "running" || status === "queued";

/** Applies an event to the cached answers; lists that an event changes in more ways than one are asked for again. */
export function applyEvent(qc: QueryClient, e: ServerEvent): void {
  switch (e.kind) {
    case "run":
      qc.setQueryData<RunWithSteps>(keys.run(e.run.id), (old) => old && { ...e.run, steps: old.steps });
      void qc.invalidateQueries({ queryKey: keys.cascades });
      void qc.invalidateQueries({ queryKey: keys.allRuns });
      return;
    case "step":
      qc.setQueryData<RunWithSteps>(keys.run(e.step.runId), (old) => old && { ...old, steps: withStep(old.steps, e.step) });
      // steps take and release repos
      void qc.invalidateQueries({ queryKey: keys.repos });
      // backup, retain and copy add or remove snapshots; only lists on screen are asked for again
      if (!isActive(e.step.status)) void qc.invalidateQueries({ queryKey: keys.allSnapshots });
      return;
    case "log": {
      // only for a log someone is looking at
      const key = keys.log(e.runId);
      if (qc.getQueryState(key) === undefined) return;
      qc.setQueryData<LogData>(key, (old) => ({ lines: mergeLog(old?.lines ?? [], [e.log]), complete: old?.complete ?? false }));
      return;
    }
    case "repo":
      void qc.invalidateQueries({ queryKey: keys.repos });
      return;
  }
}

function withStep(steps: StepRecord[], step: StepRecord): StepRecord[] {
  const i = steps.findIndex((s) => s.index === step.index);
  if (i >= 0) return steps.map((s, j) => (j === i ? step : s));
  return [...steps, step].sort((a, b) => a.index - b.index);
}

// a reload sends no event, so the status is polled
export const useStatus = () =>
  useQuery({ queryKey: keys.status, queryFn: () => request<DaemonStatus>("GET", "/status"), refetchInterval: 30_000 });

export const useCascades = () =>
  useQuery({ queryKey: keys.cascades, queryFn: () => request<CascadeView[]>("GET", "/cascades") });

export const useRepos = () => useQuery({ queryKey: keys.repos, queryFn: () => request<RepoView[]>("GET", "/repos") });

const repoPath = (repo: string) => `/repos/${encodeURIComponent(repo)}/snapshots`;

export const useSnapshots = (repo: string) =>
  useQuery({ queryKey: keys.snapshots(repo), queryFn: () => request<Snapshot[]>("GET", repoPath(repo)) });

/** A directory of a snapshot does not change: it is not asked for again while cached. */
export const snapshotDirQuery = (repo: string, id: string, path: string) => ({
  queryKey: keys.snapshotDir(repo, id, path),
  queryFn: () => request<SnapshotDir>("GET", `${repoPath(repo)}/${encodeURIComponent(id)}/ls?${new URLSearchParams({ path })}`),
  staleTime: Infinity,
});

export const useSnapshotDir = (repo: string, id: string, path: string) => useQuery(snapshotDirQuery(repo, id, path));

/** Starts restoring paths of a snapshot (all of it for none) into the daemon's restore directory. */
export const useRestore = (repo: string, id: string) =>
  useMutation({
    mutationFn: (paths: string[]) =>
      request<RunRecord>("POST", `${repoPath(repo)}/${encodeURIComponent(id)}/restore`, undefined, { paths }),
  });

export const useRun = (id: number) =>
  useQuery({ queryKey: keys.run(id), queryFn: () => request<RunWithSteps>("GET", `/runs/${id}`) });

/** A page of runs, newest first, with the number of all of them; the page on screen stays while the next one loads. */
export function useRuns(cascade: string | undefined, page: number) {
  return useQuery({
    queryKey: keys.runs(cascade, page),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ limit: String(RUNS_PAGE), offset: String((page - 1) * RUNS_PAGE) });
      if (cascade !== undefined) params.set("cascade", cascade);
      const res = await send("GET", `/runs?${params}`, signal);
      return { runs: (await res.json()) as RunRecord[], total: Number(res.headers.get("x-total-count") ?? 0) };
    },
    placeholderData: keepPreviousData,
  });
}

/**
 * A run's log. Lines from events are merged in as they come (see `applyEvent`), so fetching again after a
 * reconnect only asks for what came after the last line, once the whole log was fetched.
 */
export function useLog(id: number) {
  const qc = useQueryClient();
  const key = keys.log(id);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const have = qc.getQueryData<LogData>(key);
      const after = have?.complete ? have.lines.at(-1)?.id : undefined;
      const lines = await request<LogRecord[]>("GET", `/runs/${id}/log${after === undefined ? "" : `?after=${after}`}`);
      // read again: events may have come during the request
      return { lines: mergeLog(qc.getQueryData<LogData>(key)?.lines ?? [], lines), complete: true } satisfies LogData;
    },
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cascade: string) => request<RunRecord>("POST", `/cascades/${encodeURIComponent(cascade)}/run`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.cascades }),
  });
}

/** Starts the cascade of a run again from its failed step; the daemon says why when it cannot. */
export const useRerun = () =>
  useMutation({ mutationFn: (id: number) => request<RunRecord>("POST", `/runs/${id}/rerun`) });

/**
 * Whether the run page offers a rerun: a finished cascade run that did not succeed and ran steps.
 * The daemon also checks that the cascade still has the same steps before the failed one.
 */
export const canRerun = (run: RunWithSteps) =>
  run.cascade !== undefined && ["failed", "cancelled", "interrupted", "skipped"].includes(run.status) && run.steps.length > 0;

export const useCancelRun = () =>
  useMutation({ mutationFn: (id: number) => request<{ cancelling: boolean }>("POST", `/runs/${id}/cancel`) });
