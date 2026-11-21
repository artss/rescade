import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_NOTIFY_EVENTS, Store, type Config, type Notification, type RunRecord } from "@rescade/core";
import { Notifier, NotifyError } from "../src/notify.js";
import { baseConfig } from "../../core/test/helpers/fake.js";
import { FakeTelegram } from "./telegram.js";

const TOKEN = "123:secret-token";

let dir: string;
let store: Store;
let tg: FakeTelegram;
let logs: Array<Record<string, unknown>>;
let config: Config;
let notifier: Notifier;

const notification = (extra: Partial<Notification> = {}): Notification => ({
  type: "telegram",
  token: TOKEN,
  chat: "-100",
  events: [...DEFAULT_NOTIFY_EVENTS],
  ...extra,
});

function make(notifications: Record<string, Notification>, extra: { publicUrl?: string; retryDelaysMs?: number[] } = {}) {
  config = {
    ...baseConfig({
      home: { schedule: [], onBusy: "skip", steps: [{ type: "retain", repo: "a" }] },
      offsite: { schedule: [], onBusy: "skip", steps: [{ type: "copy", from: "a", to: "b" }] },
      tools: { schedule: [], onBusy: "skip", steps: [{ type: "run", shell: true, command: "true", env: {}, timeoutMs: 1000, lock: ["c"] }] },
    }),
    notifications,
  };
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) logs.push(JSON.parse(line));
      done();
    },
  });
  notifier = new Notifier({
    config: () => config,
    store,
    logger: pino({ level: "debug" }, sink),
    hostname: "nas",
    telegramApi: tg.url,
    retryDelaysMs: extra.retryDelaysMs ?? [10, 10],
    ...(extra.publicUrl === undefined ? {} : { publicUrl: extra.publicUrl }),
  });
  return notifier;
}

/** Inserts a finished run of the cascade. */
function finished(cascade: string, status: RunRecord["status"], reason?: string): RunRecord {
  return store.insertRun({ cascade, trigger: "schedule", status, startedAt: 1_000, finishedAt: 62_000, ...(reason ? { reason } : {}) });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rescade-notify-"));
  store = await Store.open(path.join(dir, "db"));
  tg = await FakeTelegram.start();
  logs = [];
});
afterEach(async () => {
  await notifier?.stop(1000);
  store.close();
  await tg.close();
  await rm(dir, { recursive: true, force: true });
});

describe("runs", () => {
  it("tells about a failed run with its reason, trigger, duration, host and link", async () => {
    make({ ops: notification({ thread: 5 }) }, { publicUrl: "https://backup.example.com" });
    const run = finished("home", "failed", "retain a: restic forget failed (exit code 1): <oops> & more");
    notifier.runFinished(run);
    await notifier.stop(1000);
    expect(tg.sent).toEqual([
      {
        token: TOKEN,
        method: "sendMessage",
        body: {
          chat_id: "-100",
          message_thread_id: 5,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          text: [
            "❌ <b>home</b>: failed",
            "retain a: restic forget failed (exit code 1): &lt;oops&gt; &amp; more",
            "<i>schedule · 1m1s · host nas</i>",
            `<a href="https://backup.example.com/runs/${run.id}">Run ${run.id}</a>`,
          ].join("\n"),
        },
      },
    ]);
  });

  it("sends only the events and cascades a notification asks for", async () => {
    make({
      all: notification(),
      home: notification({ chat: "home", events: ["failed", "success"], cascades: ["home"] }),
      quiet: notification({ chat: "quiet", events: ["interrupted"] }),
    });
    notifier.runFinished(finished("home", "success"));
    notifier.runFinished(finished("offsite", "failed"));
    notifier.runFinished(finished("offsite", "skipped"));
    notifier.runFinished({ ...finished("home", "running"), finishedAt: undefined } as RunRecord);
    notifier.runFinished(finished("home", "failed"));
    await notifier.stop(1000);
    const got = tg.sent.map((s) => [s.body.chat_id, String(s.body.text).split("\n")[0]]);
    expect(got.sort()).toEqual(
      [
        ["-100", "❌ <b>offsite</b>: failed"],
        ["-100", "❌ <b>home</b>: failed"],
        ["home", "✅ <b>home</b>: success"],
        ["home", "❌ <b>home</b>: failed"],
      ].sort(),
    );
  });

  it("tells about a recovery once, after a failed or interrupted run, ignoring skipped ones in between", async () => {
    make({ ops: notification(), chatty: notification({ chat: "chatty", events: ["success", "recovered"] }) });
    finished("home", "failed");
    finished("home", "skipped");
    notifier.runFinished(finished("home", "warning", "backup: some source files could not be read"));
    notifier.runFinished(finished("home", "success"));
    finished("offsite", "interrupted");
    notifier.runFinished(finished("offsite", "success"));
    await notifier.stop(1000);
    const got = tg.sent.map((s) => [s.body.chat_id, String(s.body.text).split("\n")[0]]);
    expect(got).toEqual([
      ["-100", "✅ <b>home</b>: recovered with a warning"],
      ["chatty", "✅ <b>home</b>: recovered with a warning"],
      ["chatty", "✅ <b>home</b>: success"],
      ["-100", "✅ <b>offsite</b>: recovered"],
      ["chatty", "✅ <b>offsite</b>: recovered"],
    ]);
  });

  it("tells about failed restores, to notifications whose cascades use the repo", async () => {
    make({
      all: notification({ chat: "all" }),
      offsite: notification({ chat: "offsite", cascades: ["offsite"] }),
      tools: notification({ chat: "tools", cascades: ["tools"] }),
      everything: notification({ chat: "everything", events: ["success", "failed"] }),
    });
    const restore = { repo: "b", snapshot: "0123456789abcdef", paths: [], target: "/restore/01234567" };
    const run = (status: RunRecord["status"]) =>
      store.insertRun({ restore, trigger: "manual", status, startedAt: 0, finishedAt: 1000, reason: "restore b: denied" });
    notifier.runFinished(run("success"));
    notifier.runFinished(run("failed"));
    await notifier.stop(1000);
    expect(tg.sent.map((s) => s.body.chat_id).sort()).toEqual(["all", "everything", "offsite"]);
    expect(tg.texts()[0]).toMatch(/^❌ restore of <b>01234567<\/b> from <b>b<\/b>: failed\nrestore b: denied\n<i>manual · 1s · host nas<\/i>$/);
  });
});

describe("repos", () => {
  it("tells when a repo gets a problem and when it is ok again, not on every check", async () => {
    make({ all: notification({ chat: "all" }), tools: notification({ chat: "tools", cascades: ["tools"] }) }, { publicUrl: "http://nas:8765" });
    const ok = { ok: true as const, config: { id: "x", chunkerPolynomial: "1" }, initialized: false, locks: { count: 0, locks: [] } };
    const down = { ok: false as const, problem: "unreachable" as const, reason: "dial tcp: connection refused" };
    notifier.repoChecked("a", ok);
    notifier.repoChecked("a", down);
    notifier.repoChecked("a", down);
    notifier.repoChecked("a", { ok: false, problem: "cancelled", reason: "cancelled" });
    notifier.repoChecked("a", ok);
    notifier.repoChecked("a", ok);
    notifier.repoChecked("c", { ok: false, problem: "wrong-password", reason: "wrong password" });
    await notifier.stop(1000);
    // each notification has its own queue: the order holds within a chat
    const byChat = (chat: string) => tg.sent.filter((s) => s.body.chat_id === chat).map((s) => [chat, s.body.text]);
    expect([...byChat("all"), ...byChat("tools")]).toEqual([
      ["all", '⚠️ repo <b>a</b>: unreachable\ndial tcp: connection refused\n<i>host nas</i>\n<a href="http://nas:8765/repos/a">Repo</a>'],
      ["all", '✅ repo <b>a</b>: ok again\n<i>host nas</i>\n<a href="http://nas:8765/repos/a">Repo</a>'],
      ["all", '⚠️ repo <b>c</b>: wrong-password\nwrong password\n<i>host nas</i>\n<a href="http://nas:8765/repos/c">Repo</a>'],
      ["tools", '⚠️ repo <b>c</b>: wrong-password\nwrong password\n<i>host nas</i>\n<a href="http://nas:8765/repos/c">Repo</a>'],
    ]);
  });
});

describe("reloads", () => {
  it("tells about a failed reload with the first errors, and about the next good one", async () => {
    make({ ops: notification(), runs: notification({ chat: "runs", events: ["failed"] }) });
    const errors = Array.from({ length: 7 }, (_, i) => `a.yaml:${i + 1}:1: error: bad <${i}>`);
    notifier.reloaded({ at: 1, ok: true, errors: [] });
    notifier.reloaded({ at: 2, ok: false, errors });
    notifier.reloaded({ at: 3, ok: true, errors: [] });
    notifier.reloaded({ at: 4, ok: true, errors: [] });
    await notifier.stop(1000);
    expect(tg.sent.map((s) => s.body.chat_id)).toEqual(["-100", "-100"]);
    expect(tg.texts()).toEqual([
      [
        "❌ config reload failed, the current config stays in use",
        `<pre>${errors.slice(0, 5).join("\n").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
        "and 2 more",
        "<i>host nas</i>",
      ].join("\n"),
      "✅ config reloaded\n<i>host nas</i>",
    ]);
  });
});

describe("delivery", () => {
  it("tries again after 5xx and 429 and keeps the order of a queue", async () => {
    make({ ops: notification() });
    tg.answers.push(
      { status: 502, body: {} },
      { status: 429, body: { ok: false, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } } },
    );
    notifier.runFinished(finished("home", "failed", "first"));
    notifier.runFinished(finished("home", "failed", "second"));
    await notifier.stop(5000);
    expect(tg.texts().map((t) => t.split("\n")[1])).toEqual(["first", "first", "first", "second"]);
    expect(logs.filter((l) => l.level === 50)).toEqual([]);
  });

  it("gives up after the last attempt, and at once on a refusal, logging without the token", async () => {
    make({ ops: notification() });
    tg.answers.push(
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 400, body: { ok: false, description: "Bad Request: chat not found" } },
    );
    notifier.runFinished(finished("home", "failed"));
    notifier.runFinished(finished("home", "interrupted"));
    await notifier.stop(5000);
    expect(tg.sent).toHaveLength(4);
    const errors = logs.filter((l) => l.level === 50).map((l) => [l.event, l.msg]);
    expect(errors).toEqual([
      ["failed", "could not send a notification: Telegram answered: HTTP 500"],
      ["interrupted", "could not send a notification: Telegram answered: Bad Request: chat not found"],
    ]);
    expect(JSON.stringify(logs)).not.toContain("secret-token");
  });

  it("reports an unreachable Telegram without the token", async () => {
    await tg.close();
    make({ ops: notification() }, { retryDelaysMs: [] });
    const err = await notifier.test(notification()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotifyError);
    expect((err as Error).message).toMatch(/^Telegram is not reachable: ECONNREFUSED$/);
    tg = await FakeTelegram.start();
  });

  it("sends a test message once and throws what Telegram said", async () => {
    make({});
    await notifier.test(notification());
    expect(tg.texts()).toEqual(["🔔 rescade test message\n<i>host nas</i>"]);
    tg.answers.push({ status: 500, body: { ok: false, description: "Internal Server Error" } });
    await expect(notifier.test(notification())).rejects.toThrow("Telegram answered: Internal Server Error");
    expect(tg.sent).toHaveLength(2);
  });

  it("drops what is left when the stop waits too long, and sends nothing after it", async () => {
    make({ ops: notification() }, { retryDelaysMs: [60_000] });
    tg.answers.push({ status: 503, body: {} });
    notifier.runFinished(finished("home", "failed"));
    const started = Date.now();
    await notifier.stop(100);
    expect(Date.now() - started).toBeLessThan(2000);
    notifier.runFinished(finished("home", "failed"));
    await new Promise((r) => setTimeout(r, 50));
    expect(tg.sent).toHaveLength(1);
  });
});
