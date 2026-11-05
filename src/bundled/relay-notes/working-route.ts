import type {
  JsonValue,
  OpenTarget,
  NoteDestination,
} from "../../features/navigation/targets";
import { PUBKEY, UUID } from "../../features/notes/model";
import { notePageRoute } from "../../features/notes/target";

export type DocumentView = Omit<NoteDestination, "id" | "channel">;
export type WorkingRoute = DocumentView & {
  view: "browse" | "page" | "new";
  id?: string;
  channel?: string;
  draft?: string;
  query?: string;
  trash?: boolean;
};
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
]);

/** Addresses and presentation only. Draft text never enters browser history. */
export function workingRoute(
  value: JsonValue | undefined,
): WorkingRoute | undefined {
  if (value === undefined) return { view: "browse" };
  const old = notePageRoute(value);
  if (old) return { view: "page", ...old };
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = { ...value } as Record<string, JsonValue>;
  if (row.view === "note" || row.view === "document") row.view = "page";
  if (
    Object.keys(row).some((key) => !keys.has(key)) ||
    typeof row.view !== "string" ||
    !["browse", "page", "new"].includes(row.view)
  )
    return;
  if (
    row.view === "page"
      ? typeof row.id !== "string" ||
        !UUID.test(row.id) ||
        typeof row.channel !== "string" ||
        !UUID.test(row.channel)
      : row.id !== undefined || row.channel !== undefined
  )
    return;
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
  if (
    ["edit", "trash"].some(
      (key) => row[key] !== undefined && typeof row[key] !== "boolean",
    )
  )
    return;
  if (
    row.dialog !== undefined &&
    (row.view !== "page" ||
      typeof row.dialog !== "string" ||
      !["share", "history", "link", "delete"].includes(row.dialog))
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
  if (
    row.offset !== undefined &&
    (row.dialog !== "history" ||
      !Number.isInteger(row.offset) ||
      Number(row.offset) < 0 ||
      Number(row.offset) > 10000)
  )
    return;
  return row as WorkingRoute;
}
export function workingTarget(
  target: Extract<OpenTarget, { kind: "page" }>,
  route: WorkingRoute,
): OpenTarget {
  if (!workingRoute({ ...route }))
    throw new Error("Invalid working-note destination.");
  return { ...target, route: { version: 1, params: { ...route } } };
}
