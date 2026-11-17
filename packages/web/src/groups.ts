/** An item without a group, or a group with its items. */
export type Grouped<T> = { item: T } | { group: string; items: T[] };

/**
 * Keeps the config order: an item without a group stays where it is, a group takes the place of its first item
 * and gathers the rest of its items there.
 */
export function groupItems<T>(items: T[], groupOf: (item: T) => string | null | undefined): Grouped<T>[] {
  const out: Grouped<T>[] = [];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = groupOf(item);
    if (name === null || name === undefined) {
      out.push({ item });
      continue;
    }
    const members = groups.get(name);
    if (members) members.push(item);
    else {
      const created = [item];
      groups.set(name, created);
      out.push({ group: name, items: created });
    }
  }
  return out;
}
