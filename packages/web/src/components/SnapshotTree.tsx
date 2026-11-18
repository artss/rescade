import { asyncDataLoaderFeature, hotkeysCoreFeature, type ItemInstance } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { formatBytes } from "../format.js";
import { keys, snapshotDirQuery, useRestore, useStatus } from "../queries.js";
import { checkState, restorePaths, toggle, type Children, type Picked } from "../selection.js";
import type { Snapshot, SnapshotDir, SnapshotEntry } from "../types.js";
import { Button } from "./Button.js";
import { ErrorBox } from "./ErrorBox.js";
import { Time } from "./Time.js";

/** A tree item: an entry of the snapshot, or a line about a directory's listing (cut short, empty, failed). */
type Node = { kind: "entry"; entry: SnapshotEntry } | { kind: "note"; dir: string; text: string; failed: boolean };

const ROOT = "/";
const INDENT = 20;
// name, owner, permissions, size, modified, symlink
const columns = "grid grid-cols-[minmax(16rem,1fr)_6rem_7rem_6rem_12rem_4.5rem] items-center gap-x-3";

/** Directories first, then by name. */
const sorted = (entries: SnapshotEntry[]) =>
  [...entries].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));

const noteId = (dir: string) => `${dir}\u0000note`;

/**
 * The files of a snapshot as a tree, folded at first; a directory is listed when it is opened. Checked files and
 * directories are restored into `<restore dir>/<short id>` of the daemon.
 */
export function SnapshotTree({ repo, snapshot }: { repo: string; snapshot: Snapshot }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Picked>(new Set());

  const tree = useTree<Node>({
    rootItemId: ROOT,
    getItemName: (item) => {
      const d = item.getItemData();
      return d?.kind === "entry" ? d.entry.name : (d?.text ?? "");
    },
    isItemFolder: (item) => {
      const d = item.getItemData();
      return d?.kind === "entry" && d.entry.type === "dir";
    },
    dataLoader: {
      getItem: (path) => ({ kind: "entry", entry: { name: path, type: "dir", path } }),
      getChildrenWithData: async (dir) => {
        try {
          const listed = await qc.fetchQuery(snapshotDirQuery(repo, snapshot.id, dir));
          const items: { id: string; data: Node }[] = sorted(listed.entries).map((e) => ({ id: e.path, data: { kind: "entry", entry: e } }));
          const note = listed.truncated
            ? `Only the first ${listed.entries.length} entries are shown.`
            : listed.entries.length === 0 && dir !== ROOT
              ? "Empty directory."
              : undefined;
          if (note !== undefined) items.push({ id: noteId(dir), data: { kind: "note", dir, text: note, failed: false } });
          return items;
        } catch (e) {
          // headless-tree would wait for a failed load forever
          return [{ id: noteId(dir), data: { kind: "note", dir, text: e instanceof Error ? e.message : String(e), failed: true } }];
        }
      },
    },
    indent: INDENT,
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
  });

  /** Entries of a directory, if all of them were listed. */
  const children: Children = (dir) => {
    const listed = qc.getQueryData<SnapshotDir>(keys.snapshotDir(repo, snapshot.id, dir));
    return listed && !listed.truncated ? listed.entries.map((e) => e.path) : undefined;
  };

  const items = tree.getItems();
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="min-w-fit text-sm">
          <div className={`${columns} border-b border-zinc-200 px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800`}>
            <span className="pl-11">Name</span>
            <span>Owner</span>
            <span>Permissions</span>
            <span className="text-right">Size</span>
            <span>Modified</span>
            <span>Symlink</span>
          </div>
          <div {...tree.getContainerProps("Files")} className="py-1 outline-none">
            {items.map((item) => (
              <Row key={item.getId()} item={item} picked={picked} listed={children} onPick={setPicked} />
            ))}
          </div>
          {items.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">Empty directory.</p>}
        </div>
      </div>
      {picked.size > 0 && <RestoreBar repo={repo} snapshot={snapshot} picked={picked} />}
    </div>
  );
}

function Row({
  item,
  picked,
  listed,
  onPick,
}: {
  item: ItemInstance<Node>;
  picked: Picked;
  listed: Children;
  onPick: (next: Picked) => void;
}) {
  const d = item.getItemData();
  const pad = { paddingLeft: `${item.getItemMeta().level * INDENT}px` };
  const focus = "rounded outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

  if (d?.kind !== "entry") {
    return (
      <div {...item.getProps()} className={`${focus} px-3 py-1`}>
        <div style={pad} className={`pl-11 text-sm ${d?.failed ? "text-red-700 dark:text-red-400" : "text-zinc-500"}`}>
          {d?.text}
          {d?.failed && (
            <button
              type="button"
              className="ml-2 text-sky-700 hover:underline dark:text-sky-400"
              onClick={(e) => {
                e.stopPropagation();
                void item.getTree().getItemInstance(d.dir).invalidateChildrenIds();
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  const e = d.entry;
  const state = checkState(picked, e.path);
  const next = toggle(picked, e.path, listed);
  const folder = item.isFolder();
  return (
    <div {...item.getProps()} className={`${columns} ${focus} cursor-default px-3 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50`}>
      <span style={pad} className="flex min-w-0 items-center gap-1.5">
        <input
          type="checkbox"
          aria-label={`Restore ${e.path}`}
          checked={state === "checked"}
          ref={(el) => {
            if (el) el.indeterminate = state === "indeterminate";
          }}
          disabled={next === undefined}
          title={next === undefined ? "The directory above has more entries than are shown" : undefined}
          onClick={(ev) => ev.stopPropagation()}
          onChange={() => next && onPick(next)}
          className="size-4 shrink-0 accent-sky-600"
        />
        <span aria-hidden className="w-4 shrink-0 text-center text-zinc-400">
          {folder ? (item.isLoading() ? "…" : item.isExpanded() ? "▾" : "▸") : ""}
        </span>
        <span className="break-all font-mono">{folder ? `${e.name}/` : e.name}</span>
      </span>
      <span className="font-mono text-xs text-zinc-500">{e.uid === undefined ? "" : `${e.uid}:${e.gid ?? "?"}`}</span>
      <span className="font-mono text-xs text-zinc-500">{e.permissions}</span>
      <span className="whitespace-nowrap text-right">{folder || e.size === undefined ? "" : formatBytes(e.size)}</span>
      <span className="whitespace-nowrap text-zinc-500">
        <Time ms={e.mtime} />
      </span>
      <span className="text-xs text-zinc-500">{e.type === "symlink" ? "yes" : ""}</span>
    </div>
  );
}

/** The restore button under the tree, with where the files go. */
function RestoreBar({ repo, snapshot, picked }: { repo: string; snapshot: Snapshot; picked: Picked }) {
  const { data: status } = useStatus();
  const restore = useRestore(repo, snapshot.id);
  const [, navigate] = useLocation();
  const off = status !== undefined && status.restoreDir === undefined;
  const target = status?.restoreDir === undefined ? undefined : `${status.restoreDir.replace(/\/$/, "")}/${snapshot.shortId}`;
  const paths = restorePaths(picked);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={off || restore.isPending}
          onClick={() => restore.mutate(paths, { onSuccess: (run) => navigate(`/runs/${run.id}`) })}
        >
          Restore
        </Button>
        <span className="text-sm text-zinc-500">
          <span>{paths.length === 1 ? "1 path" : `${paths.length} paths`}</span>
          {target !== undefined && (
            <>
              {" to "}
              <span className="break-all font-mono text-zinc-800 dark:text-zinc-200">{target}</span>
            </>
          )}
        </span>
      </div>
      {off && (
        <p className="text-sm text-zinc-500">
          Restore is off: start rescaded with <code>--restore-dir</code> or <code>RESCADE_RESTORE_DIR</code>.
        </p>
      )}
      {restore.error && <ErrorBox error={restore.error} />}
    </div>
  );
}
