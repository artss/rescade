/**
 * Paths of a snapshot picked for restore. Only the topmost ones are kept: a picked directory stands for everything
 * below it, so a restore request names the directory alone.
 */
export type Picked = ReadonlySet<string>;

/** The paths directly in a directory, or undefined when they are not known (not listed yet, or only in part). */
export type Children = (dir: string) => readonly string[] | undefined;

export type CheckState = "checked" | "unchecked" | "indeterminate";

export const parentOf = (p: string): string | undefined => (p === "/" ? undefined : p.slice(0, p.lastIndexOf("/")) || "/");

const isBelow = (p: string, dir: string): boolean => (dir === "/" ? p !== "/" : p.startsWith(`${dir}/`));

/** `path` itself or the directory above it that is picked. */
function pickedAtOrAbove(picked: Picked, path: string): string | undefined {
  for (let p: string | undefined = path; p !== undefined; p = parentOf(p)) if (picked.has(p)) return p;
  return undefined;
}

/** Checked when it or a directory above is picked; indeterminate when something below is. */
export function checkState(picked: Picked, path: string): CheckState {
  if (pickedAtOrAbove(picked, path) !== undefined) return "checked";
  for (const p of picked) if (isBelow(p, path)) return "indeterminate";
  return "unchecked";
}

/**
 * The picked paths after the checkbox of `path` is clicked; undefined when it cannot be unchecked alone, because a
 * picked directory above has entries that were not listed.
 *
 * Unchecking something inside a picked directory replaces the directory with what else is in it, on each level down
 * to `path`. Checking takes the place of whatever was picked below, and a directory whose entries are all picked
 * becomes picked itself.
 */
export function toggle(picked: Picked, path: string, children: Children): Set<string> | undefined {
  const next = new Set(picked);
  const above = pickedAtOrAbove(picked, path);
  if (above === path) {
    next.delete(path);
    return next;
  }
  if (above !== undefined) {
    next.delete(above);
    const chain: string[] = [];
    for (let p = path; p !== above; p = parentOf(p)!) chain.unshift(p);
    let dir = above;
    for (const step of chain) {
      const entries = children(dir);
      if (entries === undefined) return undefined;
      for (const e of entries) if (e !== step) next.add(e);
      dir = step;
    }
    return next;
  }

  for (const p of picked) if (isBelow(p, path)) next.delete(p);
  next.add(path);
  for (let dir = parentOf(path); dir !== undefined; dir = parentOf(dir)) {
    const entries = children(dir);
    if (entries === undefined || entries.length === 0 || !entries.every((e) => next.has(e))) break;
    for (const e of entries) next.delete(e);
    next.add(dir);
  }
  return next;
}

/** What a restore request names, in order. */
export const restorePaths = (picked: Picked): string[] => [...picked].sort();
