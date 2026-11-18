/** Runs on a page of the history. */
export const RUNS_PAGE = 50;

/** The page number of `?page=`: a whole number from 1, anything else is the first page. */
export function parsePage(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Which items of `total` a page shows (1-based, `from` > `to` when it is past the end) and how many pages there are. */
export function pageRange(page: number, total: number, size: number): { from: number; to: number; pages: number } {
  return { from: (page - 1) * size + 1, to: Math.min(page * size, total), pages: Math.max(1, Math.ceil(total / size)) };
}
