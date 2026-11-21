import os from "node:os";
import type { Logger } from "pino";
import {
  formatDuration,
  stepRepos,
  type Config,
  type EnsureResult,
  type Notification,
  type NotifyEvent,
  type RunnerEvent,
  type RunRecord,
  type Store,
} from "@rescade/core";
import type { ReloadResult } from "./server.js";

export const TELEGRAM_API = "https://api.telegram.org";
/** Waits before the second and the third attempt (429 waits as long as Telegram asks instead). */
export const RETRY_DELAYS_MS = [2_000, 10_000];
const SEND_TIMEOUT_MS = 10_000;
/** Telegram takes up to 4096 characters; a reason or a list of errors is cut well before that. */
const MAX_DETAIL = 1_500;
const MAX_RELOAD_ERRORS = 5;

export interface NotifierOptions {
  /** The config in use; read whenever something happens. */
  config: () => Config;
  store: Store;
  logger: Logger;
  /** The web UI as people open it, for links; absent = no links. */
  publicUrl?: string;
  /** Shown in every message, so that several daemons can share a chat. */
  hostname?: string;
  telegramApi?: string;
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

/** Telegram refused the message or could not be reached. */
export class NotifyError extends Error {
  constructor(
    message: string,
    /** Worth trying again: no connection, a timeout, 5xx or 429. */
    readonly retry: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const RUN_EVENTS = new Set<string>(["success", "warning", "failed", "cancelled", "skipped", "interrupted"]);
const ICON: Record<string, string> = {
  failed: "❌",
  interrupted: "⛔",
  warning: "⚠️",
  skipped: "⏭",
  cancelled: "✖️",
  success: "✅",
  recovered: "✅",
};

/**
 * Sends notifications about runs that went wrong (and other events the config asks for) as the daemon goes on.
 * Sending never holds up a run: every notification has its own queue, and a message that cannot be delivered
 * after a few attempts is logged and dropped.
 */
export class Notifier {
  private readonly hostname: string;
  private readonly api: string;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;
  /** Last known state of each repo: true = ok; absent = not checked yet. */
  private readonly repoOk = new Map<string, boolean>();
  private reloadFailed = false;
  /** By notification name: the end of its queue. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly stopping = new AbortController();

  constructor(private readonly options: NotifierOptions) {
    this.hostname = options.hostname ?? os.hostname();
    this.api = options.telegramApi ?? TELEGRAM_API;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  /** For `Runner.subscribe`: finished runs and repo checks. */
  readonly onRunnerEvent = (e: RunnerEvent): void => {
    if (e.kind === "run") this.runFinished(e.run);
    else if (e.kind === "repo") this.repoChecked(e.repo, e.result);
  };

  /** A run that ended (other statuses are ignored); also the runs found unfinished at the start. */
  runFinished(run: RunRecord): void {
    if (!RUN_EVENTS.has(run.status)) return;
    const event = run.status as NotifyEvent;
    const config = this.options.config();
    if (run.restore !== undefined) {
      // a restore is started by hand: only its failures are worth a message
      if (event !== "failed" && event !== "interrupted") return;
      const repo = run.restore.repo;
      for (const [name, n] of this.matching(config, event, (c) => touches(config, c, repo))) {
        this.enqueue(name, n, event, this.runText(run, event));
      }
      return;
    }
    const cascade = run.cascade!;
    const wanted = (n: Notification) => n.cascades === undefined || n.cascades.includes(cascade);
    let recovered: boolean | undefined;
    const isRecovery = () => {
      recovered ??=
        (event === "success" || event === "warning") &&
        ["failed", "interrupted"].includes(this.options.store.previousOutcome(cascade, run.id) ?? "");
      return recovered;
    };
    for (const [name, n] of Object.entries(config.notifications)) {
      if (!wanted(n)) continue;
      // one message per run: a recovery is told as such, even when the status itself is also asked for
      if (n.events.includes("recovered") && isRecovery()) this.enqueue(name, n, "recovered", this.runText(run, "recovered"));
      else if (n.events.includes(event)) this.enqueue(name, n, event, this.runText(run, event));
    }
  }

  /** A check of a repo: tells when it goes from ok (or unknown) to a problem, and back. */
  repoChecked(repo: string, result: EnsureResult): void {
    if (!result.ok && result.problem === "cancelled") return;
    const before = this.repoOk.get(repo);
    this.repoOk.set(repo, result.ok);
    const config = this.options.config();
    const inScope = (c: string) => touches(config, c, repo);
    if (!result.ok && before !== false) {
      const text = [
        `${ICON.warning} repo <b>${esc(repo)}</b>: ${esc(result.problem)}`,
        esc(cut(result.reason)),
        this.footer(),
        this.link(`/repos/${encodeURIComponent(repo)}`, "Repo"),
      ];
      for (const [name, n] of this.matching(config, "repo-problem", inScope)) this.enqueue(name, n, "repo-problem", lines(text));
    } else if (result.ok && before === false) {
      const text = [`${ICON.recovered} repo <b>${esc(repo)}</b>: ok again`, this.footer(), this.link(`/repos/${encodeURIComponent(repo)}`, "Repo")];
      for (const [name, n] of this.matching(config, "recovered", inScope)) this.enqueue(name, n, "recovered", lines(text));
    }
  }

  /** The outcome of a config reload; `config` is the one in use after it (the old one when the reload failed). */
  reloaded(result: ReloadResult): void {
    const config = this.options.config();
    if (!result.ok) {
      this.reloadFailed = true;
      const shown = result.errors.slice(0, MAX_RELOAD_ERRORS);
      const more = result.errors.length - shown.length;
      const text = [
        `${ICON.failed} config reload failed, the current config stays in use`,
        shown.length > 0 ? `<pre>${esc(cut(shown.join("\n")))}</pre>` : undefined,
        more > 0 ? `and ${more} more` : undefined,
        this.footer(),
      ];
      for (const [name, n] of this.matching(config, "reload-failed")) this.enqueue(name, n, "reload-failed", lines(text));
    } else if (this.reloadFailed) {
      this.reloadFailed = false;
      const text = [`${ICON.recovered} config reloaded`, this.footer()];
      for (const [name, n] of this.matching(config, "recovered")) this.enqueue(name, n, "recovered", lines(text));
    }
  }

  /** Sends a test message right away, once; throws `NotifyError` when it does not go through. */
  async test(n: Notification): Promise<void> {
    await this.send(n, lines([`🔔 rescade test message`, this.footer()]));
  }

  /** Waits for the queues to empty, at most `timeoutMs`; after that what is left is dropped. */
  async stop(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    await Promise.race([Promise.all(this.queues.values()), timeout]);
    clearTimeout(timer);
    this.stopping.abort();
    await Promise.all(this.queues.values());
  }

  /** Notifications that want the event, limited by their cascades when `inScope` says how. */
  private matching(config: Config, event: NotifyEvent, inScope?: (cascade: string) => boolean): Array<[string, Notification]> {
    return Object.entries(config.notifications).filter(
      ([, n]) => n.events.includes(event) && (n.cascades === undefined || inScope === undefined || n.cascades.some(inScope)),
    );
  }

  private enqueue(name: string, n: Notification, event: NotifyEvent, text: string): void {
    if (this.stopping.signal.aborted) return;
    const previous = this.queues.get(name) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(n, text))
      .then(
        () => this.options.logger.debug({ notification: name, event }, "notification sent"),
        (e: unknown) =>
          this.options.logger.error(
            { notification: name, event },
            `could not send a notification: ${e instanceof Error ? e.message : String(e)}`,
          ),
      )
      .finally(() => {
        if (this.queues.get(name) === next) this.queues.delete(name);
      });
    this.queues.set(name, next);
  }

  /** `send` with retries. */
  private async deliver(n: Notification, text: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(n, text);
      } catch (e) {
        const delay = this.retryDelaysMs[attempt];
        if (!(e instanceof NotifyError) || !e.retry || delay === undefined || this.stopping.signal.aborted) throw e;
        await sleep(e.retryAfterMs ?? delay, this.stopping.signal);
      }
    }
  }

  private async send(n: Notification, text: string): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: n.chat,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (n.thread !== undefined) body.message_thread_id = n.thread;
    let response: Response;
    try {
      // the token is part of the URL: errors below never include it
      response = await fetch(`${this.api}/bot${n.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.stopping.signal]),
      });
    } catch (e) {
      throw new NotifyError(`Telegram is not reachable: ${networkReason(e)}`, true);
    }
    if (response.ok) return;
    const reply = (await response.json().catch(() => ({}))) as { description?: unknown; parameters?: { retry_after?: unknown } };
    const description = typeof reply.description === "string" ? reply.description : `HTTP ${response.status}`;
    const retryAfter = reply.parameters?.retry_after;
    throw new NotifyError(
      `Telegram answered: ${description}`,
      response.status === 429 || response.status >= 500,
      typeof retryAfter === "number" ? retryAfter * 1000 : undefined,
    );
  }

  private runText(run: RunRecord, event: NotifyEvent): string {
    const what =
      run.restore === undefined
        ? `<b>${esc(run.cascade ?? "")}</b>`
        : `restore of <b>${esc(run.restore.snapshot.slice(0, 8))}</b> from <b>${esc(run.restore.repo)}</b>`;
    const head =
      event === "recovered"
        ? `${ICON.recovered} ${what}: ${run.status === "warning" ? "recovered with a warning" : "recovered"}`
        : `${ICON[event] ?? ""} ${what}: ${run.status}`;
    const took = run.finishedAt === undefined ? undefined : formatDuration(Math.max(0, run.finishedAt - run.startedAt));
    return lines([
      head,
      run.reason === undefined ? undefined : esc(cut(run.reason)),
      this.footer(run.trigger, took),
      this.link(`/runs/${run.id}`, `Run ${run.id}`),
    ]);
  }

  private footer(...parts: Array<string | undefined>): string {
    return `<i>${esc([...parts.filter((p) => p !== undefined), `host ${this.hostname}`].join(" · "))}</i>`;
  }

  private link(path: string, label: string): string | undefined {
    const base = this.options.publicUrl;
    return base === undefined ? undefined : `<a href="${esc(base + path)}">${esc(label)}</a>`;
  }
}

/** Whether the cascade has a step that uses the repo. */
function touches(config: Config, cascade: string, repo: string): boolean {
  return config.cascades[cascade]?.steps.some((s) => stepRepos(s).includes(repo)) ?? false;
}

/** Escapes text for Telegram's HTML. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cut(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

function lines(parts: Array<string | undefined>): string {
  return parts.filter((p) => p !== undefined && p !== "").join("\n");
}

/** "ECONNREFUSED", "timed out"... from what fetch threw. */
function networkReason(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "timed out";
  const cause = e instanceof Error ? (e.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}
