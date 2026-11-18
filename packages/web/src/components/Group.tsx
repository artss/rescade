import { Fragment, useId, useState, type ReactNode } from "react";
import { isCollapsed, setCollapsed } from "../collapsed.js";
import { groupItems } from "../groups.js";

/** A heading that collapses and expands its items; expanded at first, then as the browser remembers for `list`. */
export function Group({ list, name, count, children }: { list: string; name: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(() => !isCollapsed(list, name));
  const toggle = () => {
    setCollapsed(list, name, open);
    setOpen(!open);
  };
  const id = useId();
  return (
    <section aria-label={name}>
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
          className="flex w-full items-center gap-2 py-1 text-left text-sm font-semibold text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
            ▸
          </span>
          {name}
          <span className="font-normal text-zinc-400">{count}</span>
        </button>
      </h2>
      {open && (
        <div id={id} className="mt-2 grid gap-3">
          {children}
        </div>
      )}
    </section>
  );
}

/** Items in config order; those with a group go under its collapsible heading. */
export function GroupedList<T>({
  list,
  items,
  groupOf,
  keyOf,
  render,
}: {
  /** Which list this is: groups of different lists collapse separately even under the same name. */
  list: string;
  items: T[];
  groupOf: (item: T) => string | null | undefined;
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
}) {
  return (
    <div className="grid gap-3">
      {groupItems(items, groupOf).map((g) =>
        "item" in g ? (
          <Fragment key={`item:${keyOf(g.item)}`}>{render(g.item)}</Fragment>
        ) : (
          <Group key={`group:${g.group}`} list={list} name={g.group} count={g.items.length}>
            {g.items.map((item) => (
              <Fragment key={keyOf(item)}>{render(item)}</Fragment>
            ))}
          </Group>
        ),
      )}
    </div>
  );
}
