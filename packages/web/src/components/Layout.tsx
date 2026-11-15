import type { ReactNode } from "react";
import { formatTime } from "../format.js";
import { useStatus } from "../queries.js";
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
          <span className="font-semibold">rescade</span>
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
