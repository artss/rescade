import { mdiDotsVertical, mdiGithub, mdiLogout, mdiReload } from "@mdi/js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import logo from "../assets/rescade-logo.svg";
import { formatTime } from "../format.js";
import { useReload, useStatus } from "../queries.js";
import { clearToken } from "../token.js";
import { Icon } from "./Icon.js";
import { NavLink } from "./NavLink.js";

export type Connection = "connecting" | "live" | "down";

const connectionText: Record<Connection, [string, string]> = {
  connecting: ["bg-zinc-400", "connecting"],
  live: ["bg-emerald-500", "live"],
  down: ["bg-red-500", "reconnecting"],
};

export function Layout({ connection, children }: { connection: Connection; children: ReactNode }) {
  const [dot, text] = connectionText[connection];
  return (
    <div className="flex min-h-screen flex-col">
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
            <HeaderMenu />
          </div>
        </div>
      </header>
      <ReloadBanner />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
      <Footer />
    </div>
  );
}

const menuItem =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800";

/**
 * The menu on the right of the header: reloading the config and signing out. The outcome of a reload shows next to
 * the menu button for a few seconds (config errors go to the banner below the header).
 */
export function HeaderMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const reload = useReload();
  const { isSuccess, isError, reset } = reload;
  useEffect(() => {
    if (!isSuccess && !isError) return;
    const t = setTimeout(reset, 5000);
    return () => clearTimeout(t);
  }, [isSuccess, isError, reset]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      {reload.isError && (
        <span role="status" className="text-red-600 dark:text-red-400">
          {reload.error.message}
        </span>
      )}
      {reload.data?.ok && <span role="status">config reloaded</span>}
      <div ref={root} className="relative">
        <button
          type="button"
          className="flex rounded p-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon path={mdiDotsVertical} className="size-5" />
        </button>
        {open && (
          <div
            role="menu"
            className="absolute right-0 z-10 mt-1 w-44 rounded border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              disabled={reload.isPending}
              title="Reread the config files on the daemon"
              onClick={() => {
                reload.mutate();
                setOpen(false);
              }}
            >
              <Icon path={mdiReload} />
              Reload config
            </button>
            <button type="button" role="menuitem" className={menuItem} onClick={() => clearToken()}>
              <Icon path={mdiLogout} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export function Footer() {
  const { data: status } = useStatus();
  return (
    <footer className="border-t border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 text-xs text-zinc-500">
        {status && <span title={`up since ${formatTime(status.startedAt)}`}>rescaded {status.version}</span>}
        <a
          href="https://github.com/artss/rescade"
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          <Icon path={mdiGithub} />
          GitHub
        </a>
      </div>
    </footer>
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
