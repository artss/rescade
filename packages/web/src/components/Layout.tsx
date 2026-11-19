import { useEffect, type ReactNode } from "react";
import { Link } from "wouter";
import logo from "../assets/rescade-logo.svg";
import { formatTime } from "../format.js";
import { useReload, useStatus } from "../queries.js";
import { clearToken } from "../token.js";
import { NavLink } from "./NavLink.js";

export type Connection = "connecting" | "live" | "down";

const connectionText: Record<Connection, [string, string]> = {
  connecting: ["bg-zinc-400", "connecting"],
  live: ["bg-emerald-500", "live"],
  down: ["bg-red-500", "reconnecting"],
};

export function Layout({ connection, children }: { connection: Connection; children: ReactNode }) {
  const [dot, text] = connectionText[connection];
  const { data: status } = useStatus();
  return (
    <>
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <Link href="/" className="shrink-0">
            <img src={logo} alt="rescade" className="h-7 w-7" />
          </Link>
          <nav className="flex gap-1">
            <NavLink href="/">Cascades</NavLink>
            <NavLink href="/runs">Runs</NavLink>
            <NavLink href="/repos">Repos</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs text-zinc-500">
            <span className="flex items-center gap-1.5" title="Event stream">
              <span className={`h-2 w-2 rounded-full ${dot}`} />
              {text}
            </span>
            {status && <span title={`up since ${formatTime(status.startedAt)}`}>rescaded {status.version}</span>}
            <ReloadButton />
            <button type="button" className="hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => clearToken()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <ReloadBanner />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </>
  );
}

/** Rereads the config on the daemon; config errors show in the banner below, other failures next to the button. */
export function ReloadButton() {
  const reload = useReload();
  const { isSuccess, isError, reset } = reload;
  useEffect(() => {
    if (!isSuccess && !isError) return;
    const t = setTimeout(reset, 5000);
    return () => clearTimeout(t);
  }, [isSuccess, isError, reset]);
  return (
    <>
      {reload.isError && (
        <span role="status" className="text-red-600 dark:text-red-400">
          {reload.error.message}
        </span>
      )}
      {reload.data?.ok && <span role="status">config reloaded</span>}
      <button
        type="button"
        className="hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100"
        disabled={reload.isPending}
        title="Reread the config files on the daemon"
        onClick={() => reload.mutate()}
      >
        Reload config
      </button>
    </>
  );
}

/** A reload with config errors leaves the old config in use, which is easy to miss. */
export function ReloadBanner() {
  const { data: status } = useStatus();
  const reload = status?.config.lastReload;
  if (!status || !reload || reload.ok) return null;
  return (
    <div role="alert" className="border-b border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <div className="mx-auto max-w-6xl px-4 py-2 text-sm">
        <p>
          Config reload at {formatTime(reload.at)} failed; the config loaded at {formatTime(status.config.loadedAt)} stays
          in use ({status.config.path}).
        </p>
        <ul className="mt-1 font-mono text-xs">
          {reload.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
