import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDir, listSnapshots, type ResticContext } from "../src/index.js";
import { FAKE_RESTIC, FakeState, repo } from "./helpers/fake.js";

const ID1 = "1".repeat(64);
const ID2 = "2".repeat(64);

const snapshot = (id: string, time: string, extra: Record<string, unknown> = {}) => ({
  time,
  tree: "t".repeat(64),
  paths: ["/home"],
  hostname: "box",
  username: "root",
  id,
  short_id: id.slice(0, 8),
  ...extra,
});
const node = (p: string, type: string, extra: Record<string, unknown> = {}) => ({
  name: p.split("/").at(-1),
  type,
  path: p,
  mode: 420,
  permissions: type === "dir" ? "drwxr-xr-x" : "-rw-r--r--",
  mtime: "2026-11-01T10:00:00+01:00",
  ...extra,
});

let fake: FakeState;
let ctx: ResticContext;

beforeEach(async () => {
  fake = await FakeState.create();
  fake.writeRepo("/r/a", "pw-a");
  ctx = { binary: FAKE_RESTIC, env: fake.env(), repos: { a: repo("/r/a") } };
  fake.writeSnapshots(
    "/r/a",
    [
      snapshot(ID1, "2026-11-01T10:00:00+01:00", {
        tags: ["auto"],
        summary: { total_bytes_processed: 5000, total_files_processed: 3, data_added: 1200 },
      }),
      snapshot(ID2, "2026-11-02T10:00:00+01:00", { parent: ID1 }),
    ],
    {
      [ID1]: [
        node("/home", "dir"),
        node("/home/u", "dir"),
        node("/home/u/a.txt", "file", { size: 12 }),
        node("/home/u/sub", "dir"),
        node("/home/u/sub/deep", "file", { size: 1 }),
      ],
    },
  );
});

afterEach(() => fake.remove());

describe("listSnapshots", () => {
  it("lists snapshots newest first with the summary fields", async () => {
    const r = await listSnapshots(ctx, "a");
    expect(r).toEqual({
      ok: true,
      value: [
        { id: ID2, shortId: "22222222", time: Date.parse("2026-11-02T09:00:00Z"), hostname: "box", username: "root", paths: ["/home"], tags: [], parent: ID1 },
        {
          id: ID1,
          shortId: "11111111",
          time: Date.parse("2026-11-01T09:00:00Z"),
          hostname: "box",
          username: "root",
          paths: ["/home"],
          tags: ["auto"],
          size: 5000,
          files: 3,
          dataAdded: 1200,
        },
      ],
    });
  });

  it("does not wait long for an exclusive lock", async () => {
    await listSnapshots(ctx, "a");
    expect(fake.calls()[0]?.args).toEqual(["--json", "--retry-lock", "10s"]);
  });

  it("tells a lock it could not get from other failures", async () => {
    ctx.env = fake.env({ FAKE_RESTIC_EXIT_SNAPSHOTS: "11" });
    expect(await listSnapshots(ctx, "a")).toEqual({ ok: false, problem: "locked", reason: "fake failure in snapshots" });
    ctx.repos.a = repo("/r/a", { password: "wrong" });
    ctx.env = fake.env();
    expect(await listSnapshots(ctx, "a")).toEqual({ ok: false, problem: "failed", reason: "wrong password or no key found" });
  });

  it("gives up on a repo that does not answer", async () => {
    ctx.env = fake.env({ FAKE_RESTIC_HANG: "snapshots" });
    ctx.repoCheckTimeoutMs = 300;
    const r = await listSnapshots(ctx, "a");
    expect(r).toMatchObject({ ok: false, problem: "no-answer" });
  });

  it("stops restic when cancelled", async () => {
    const ac = new AbortController();
    ctx.env = fake.env({ FAKE_RESTIC_HANG: "snapshots" });
    ctx.signal = ac.signal;
    setTimeout(() => ac.abort(), 200);
    expect(await listSnapshots(ctx, "a")).toMatchObject({ ok: false, problem: "cancelled" });
    expect(fake.sigtermReceived).toBe(true);
  });
});

describe("listDir", () => {
  it("lists what is directly in a directory, without the directory itself", async () => {
    const r = await listDir(ctx, "a", "11111111", "/home/u/");
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.path).toBe("/home/u");
    expect(r.value.snapshot.id).toBe(ID1);
    expect(r.value.truncated).toBe(false);
    expect(r.value.entries).toEqual([
      { name: "a.txt", type: "file", path: "/home/u/a.txt", size: 12, mtime: Date.parse("2026-11-01T09:00:00Z"), permissions: "-rw-r--r--" },
      { name: "sub", type: "dir", path: "/home/u/sub", mtime: Date.parse("2026-11-01T09:00:00Z"), permissions: "drwxr-xr-x" },
    ]);
    expect(fake.calls()[0]?.args).toEqual(["--json", "--retry-lock", "10s", "--", "11111111", "/home/u"]);
  });

  it("lists the root, which has no node of its own", async () => {
    const r = await listDir(ctx, "a", ID1, "/");
    expect(r.ok && r.value.entries.map((e) => e.path)).toEqual(["/home"]);
  });

  it("shows a file as itself", async () => {
    const r = await listDir(ctx, "a", ID1, "/home/u/a.txt");
    expect(r.ok && r.value.entries.map((e) => e.path)).toEqual(["/home/u/a.txt"]);
  });

  it("reports a missing path, a missing snapshot and a bad id as not found", async () => {
    expect(await listDir(ctx, "a", ID1, "/nope")).toEqual({ ok: false, problem: "not-found", reason: "no /nope in snapshot 11111111" });
    expect(await listDir(ctx, "a", "abcdef12", "/")).toEqual({
      ok: false,
      problem: "not-found",
      reason: 'no matching ID found for prefix "abcdef12"',
    });
    expect(await listDir(ctx, "a", "--help", "/")).toMatchObject({ ok: false, problem: "not-found" });
    expect(await listDir(ctx, "a", ID1, "home")).toMatchObject({ ok: false, problem: "not-found" });
    // the last two never reach restic
    expect(fake.calls()).toHaveLength(2);
  });
});
