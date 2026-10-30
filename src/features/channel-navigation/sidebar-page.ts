/** A uniform first page and expansion step for conversation sections. */
export const SIDEBAR_PAGE_SIZE = 5;

/** Keep important rows within the limit, preserving the inventory's own order. */
export function sidebarPage<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  retained: readonly (string | undefined)[] = [],
): T[] {
  const ids = new Set(rows.map((row) => row.id));
  const chosen = new Set<string>();
  for (const id of [...retained, ...rows.map((row) => row.id)]) {
    if (chosen.size >= limit) break;
    if (id && ids.has(id)) chosen.add(id);
  }
  return rows.filter((row) => chosen.has(row.id));
}
