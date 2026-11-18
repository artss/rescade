// collapsed groups of each list live in localStorage under their own key; storage can be unavailable
// (private mode, blocked site data) or hold garbage, then every group is expanded

const key = (list: string) => `rescade.collapsed.${list}`;

function read(list: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(list)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export function isCollapsed(list: string, group: string): boolean {
  return read(list).includes(group);
}

export function setCollapsed(list: string, group: string, collapsed: boolean): void {
  const names = read(list).filter((n) => n !== group);
  if (collapsed) names.push(group);
  try {
    if (names.length) localStorage.setItem(key(list), JSON.stringify(names));
    else localStorage.removeItem(key(list));
  } catch {
    // kept until the page reloads
  }
}
