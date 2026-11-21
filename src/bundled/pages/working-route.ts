import type { Context } from "../../plugins/author";
import { UUID, PUBKEY, noteAddress } from "./model";
import { communityOrigin } from "./links";
export type DocumentView = {
  edit?: boolean;
  dialog?: "share" | "history" | "link" | "delete";
  revision?: string;
  offset?: number;
};
export type WorkingRoute = DocumentView & {
  view: "browse" | "page" | "new";
  id?: string;
  channel?: string;
  draft?: string;
  query?: string;
  trash?: boolean;
  community?: string;
};
export type OpenTarget = Parameters<Context["navigation"]["open"]>[0];
const keys = new Set([
  "view",
  "id",
  "channel",
  "draft",
  "query",
  "trash",
  "edit",
  "dialog",
  "revision",
  "offset",
  "community",
]);
export function workingRoute(value: unknown): WorkingRoute | undefined {
  if (value === undefined) return { view: "browse" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  // Old history entries may still point to the retired Shared with me folder.
  const { folder, ...row } = value as Record<string, unknown>;
  if (folder !== undefined && folder !== "shared") return;
  if (
    Object.keys(row).some((key) => !keys.has(key)) ||
    !["browse", "page", "new"].includes(row.view as string)
  )
    return;
  if (row.view === "page") {
    try {
      noteAddress(row);
    } catch {
      return;
    }
  } else if (row.id !== undefined || row.channel !== undefined) return;
  if (
    row.view === "new"
      ? typeof row.draft !== "string" || !UUID.test(row.draft)
      : row.draft !== undefined
  )
    return;
  if (
    row.query !== undefined &&
    (typeof row.query !== "string" || row.query.length > 512)
  )
    return;
  for (const key of ["edit", "trash"]) {
    if (row[key] === "true") row[key] = true;
    else if (row[key] === "false") row[key] = false;
    else if (row[key] !== undefined && typeof row[key] !== "boolean") return;
  }
  if (
    row.dialog !== undefined &&
    (row.view !== "page" ||
      !["share", "history", "link", "delete"].includes(row.dialog as string))
  )
    return;
  if (row.edit !== undefined && row.view !== "page") return;
  if (
    row.revision !== undefined &&
    (row.dialog !== "history" ||
      typeof row.revision !== "string" ||
      !PUBKEY.test(row.revision))
  )
    return;
  if (typeof row.offset === "string" && /^\d+$/.test(row.offset))
    row.offset = Number(row.offset);
  if (
    row.offset !== undefined &&
    (row.dialog !== "history" ||
      !Number.isInteger(row.offset) ||
      Number(row.offset) < 0 ||
      Number(row.offset) > 10000)
  )
    return;
  if (row.community !== undefined) {
    try {
      if (typeof row.community !== "string") return;
      row.community = communityOrigin(row.community);
    } catch {
      return;
    }
  }
  return row as WorkingRoute;
}
export function workingTarget(
  target: Extract<OpenTarget, { kind: "page" }>,
  route: WorkingRoute,
): OpenTarget {
  if (!workingRoute(route)) throw new Error("Invalid doc destination.");
  return { ...target, route: { version: 1, params: { ...route } } };
}
