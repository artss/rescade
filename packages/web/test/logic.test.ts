import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { mergeLog, type LogData } from "../src/log.js";
import { applyEvent, keys } from "../src/queries.js";
import { parseEvents } from "../src/sse.js";
import { formatBytes, formatDuration } from "../src/format.js";
import { groupItems } from "../src/groups.js";
import { stepDetails } from "../src/steps.js";
import type { CascadeStep, LogRecord, RunWithSteps } from "../src/types.js";

async function* from(chunks: string[]) {
  for (const c of chunks) yield c;
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseEvents(from(chunks))) out.push(data);
  return out;
}

const line = (id: number, step = 0): LogRecord => ({ id, step, ts: id, stream: "stdout", line: `line ${id}` });

describe("event stream", () => {
  it("parses events split anywhere across chunks and skips comments", async () => {
    const text = ': connected\n\nevent: run\ndata: {"a":1}\n\n: keep-alive\n\nevent: log\ndata: {"b":2}\n\n';
    const whole = await collect([text]);
    expect(whole).toEqual(['{"a":1}', '{"b":2}']);
    for (let cut = 1; cut < text.length; cut++) {
      expect(await collect([text.slice(0, cut), text.slice(cut)])).toEqual(whole);
    }
  });

  it("joins data lines of one event and keeps an unfinished event back", async () => {
    expect(await collect(["data: a\ndata: b\n\ndata: unfinished\n"])).toEqual(["a\nb"]);
  });
});

describe("log merging", () => {
  it("appends newer lines and drops repeats, whatever order they come in", () => {
    expect(mergeLog([line(1), line(2)], [line(3)])).toEqual([line(1), line(2), line(3)]);
    expect(mergeLog([line(5), line(7)], [line(1), line(5), line(6)])).toEqual([line(1), line(5), line(6), line(7)]);
    const have = [line(1)];
    expect(mergeLog(have, [])).toBe(have);
  });
});

describe("events in the query cache", () => {
  const run: RunWithSteps = {
    id: 4,
    cascade: "daily",
    trigger: "manual",
    status: "queued",
    reason: "waiting for repo a",
    startedAt: 1,
    steps: [{ runId: 4, index: 0, type: "retain", label: "retain a", status: "queued" }],
  };

  it("updates a cached run and its steps, without the reason it no longer has", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.run(4), run);
    applyEvent(qc, { kind: "run", run: { id: 4, cascade: "daily", trigger: "manual", status: "running", startedAt: 1 } });
    applyEvent(qc, { kind: "step", step: { runId: 4, index: 0, type: "retain", label: "retain a", status: "running" } });
    applyEvent(qc, { kind: "step", step: { runId: 4, index: 1, type: "check", label: "check a", status: "running" } });
    const cached = qc.getQueryData<RunWithSteps>(keys.run(4))!;
    expect(cached.status).toBe("running");
    expect(cached).not.toHaveProperty("reason");
    expect(cached.steps.map((s) => [s.index, s.status])).toEqual([
      [0, "running"],
      [1, "running"],
    ]);
    // a run nobody looked at is not made up from events
    applyEvent(qc, { kind: "run", run: { id: 5, cascade: "daily", trigger: "manual", status: "running", startedAt: 1 } });
    expect(qc.getQueryData(keys.run(5))).toBeUndefined();
  });

  it("asks for lists again when runs change", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.cascades, []);
    qc.setQueryData(keys.runs("daily"), { pages: [], pageParams: [] });
    qc.setQueryData(keys.repos, []);
    applyEvent(qc, { kind: "run", run: { ...run, status: "running" } });
    expect(qc.getQueryState(keys.cascades)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.runs("daily"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.repos)?.isInvalidated).toBe(false);
    applyEvent(qc, { kind: "repo", repo: "a", at: 1 });
    expect(qc.getQueryState(keys.repos)?.isInvalidated).toBe(true);
  });

  it("collects log lines only for a log that is being looked at, marked incomplete until fetched", () => {
    const qc = new QueryClient();
    applyEvent(qc, { kind: "log", runId: 4, log: line(1) });
    expect(qc.getQueryData(keys.log(4))).toBeUndefined();

    qc.setQueryData<LogData>(keys.log(4), { lines: [line(1)], complete: true });
    applyEvent(qc, { kind: "log", runId: 4, log: line(2) });
    applyEvent(qc, { kind: "log", runId: 4, log: line(2) });
    expect(qc.getQueryData(keys.log(4))).toEqual({ lines: [line(1), line(2)], complete: true });

    qc.getQueryCache().build(qc, { queryKey: keys.log(9) });
    applyEvent(qc, { kind: "log", runId: 9, log: line(3) });
    expect(qc.getQueryData(keys.log(9))).toEqual({ lines: [line(3)], complete: false });
  });
});

describe("formatting", () => {
  it("formats durations and sizes", () => {
    expect([450, 12_400, 185_000, 7_620_000].map(formatDuration)).toEqual(["450ms", "12s", "3m 05s", "2h 07m"]);
    expect([512, 1536, 3.5 * 1024 ** 3].map(formatBytes)).toEqual(["512 B", "1.5 KiB", "3.5 GiB"]);
  });
});

describe("stepDetails", () => {
  it("shows what a backup takes from its set", () => {
    const step: CascadeStep = {
      type: "backup",
      label: "backup docs -> b",
      name: null,
      set: "docs",
      repo: "b",
      include: ["/srv/docs", "/srv/wiki"],
      exclude: [],
      tags: ["docs"],
      oneFileSystem: true,
      excludeCaches: false,
    };
    expect(stepDetails(step)).toEqual([
      ["Paths", "/srv/docs, /srv/wiki"],
      ["Tags", "docs"],
      ["Options", "one file system"],
    ]);
    expect(stepDetails({ ...step, name: "docs" })[0]).toEqual(["To", "docs -> b"]);
  });

  it("shows the retention and the settings of a run step", () => {
    expect(
      stepDetails({ type: "retain", label: "retain a", name: null, repo: "a", retention: { daily: 7, weekly: 4, within: "1y" } }),
    ).toEqual([["Keep", "7 daily, 4 weekly, within 1y"]]);
    expect(stepDetails({ type: "copy", label: "copy a -> b", name: null, from: "a", to: "b" })).toEqual([]);
    expect(
      stepDetails({
        type: "run",
        label: "dump",
        name: "dump",
        shell: false,
        argv: ["/bin/dump", "--all"],
        cwd: null,
        env: ["PGPASSWORD"],
        timeoutMs: 600_000,
        lock: [],
      }),
    ).toEqual([
      ["Command", "/bin/dump --all"],
      ["Env", "PGPASSWORD"],
      ["Timeout", "10m 00s"],
    ]);
  });
});

describe("groupItems", () => {
  it("keeps the config order, a group in the place of its first item", () => {
    const items = [
      { n: "a", g: null },
      { n: "b", g: "x" },
      { n: "c", g: undefined },
      { n: "d", g: "y" },
      { n: "e", g: "x" },
    ];
    expect(groupItems(items, (i) => i.g).map((g) => ("item" in g ? g.item.n : `${g.group}:${g.items.map((i) => i.n).join("")}`))).toEqual([
      "a",
      "x:be",
      "c",
      "y:d",
    ]);
  });
});
