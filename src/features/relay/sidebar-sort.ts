export type SidebarSortMode = "alpha" | "recent" | `plugin:${string}`;

export function isSidebarSortMode(value: unknown): value is SidebarSortMode {
  return (
    value === "alpha" ||
    value === "recent" ||
    (typeof value === "string" &&
      value.length <= 512 &&
      /^plugin:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(
        value,
      ))
  );
}

/** Sidebar-placed pages, such as Activity, ordered among the sections. */
export const SIDEBAR_PAGES_SECTION = "pages";

/** An unsaved card reads as A–Z, as every app version has always read it, so
 * an older A–Z choice (stored as absence) never turns into Recent. Solo is the
 * one exception: it reads as Recent and always saves its choice explicitly. */
export function defaultSidebarSort(group: string): SidebarSortMode {
  return group === "solo" ? "recent" : "alpha";
}

export function sidebarSortNeedsActivity(mode: SidebarSortMode): boolean {
  return mode === "recent" || mode.startsWith("plugin:");
}
