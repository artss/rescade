import type { ReactNode } from "react";
import { Link, useRoute } from "wouter";

/** A link marked as current on its page and, except for "/", on pages under it. */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const [exact] = useRoute(href);
  const [nested] = useRoute(`${href}/*`);
  const active = exact || (href !== "/" && nested);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded px-2 py-1 text-sm ${active ? "bg-zinc-200 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"}`}
    >
      {children}
    </Link>
  );
}
