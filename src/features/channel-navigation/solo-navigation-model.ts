import type { ChannelSummary } from "../relay/contracts";
import { ownSolo } from "../solo/labels";
import type {
  SoloTaskRow,
  SoloTaskStatus,
  SoloViewOptions,
} from "./solo-navigation-contract";

export const SOLO_VIEW_DEFAULTS: SoloViewOptions = Object.freeze({
  group: "workspace",
  sort: "recent",
  show: "all-chats",
});
export const SOLO_STATUS_LABELS: Record<SoloTaskStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  archived: "Archived",
};
export function soloViewOptions(value: unknown): SoloViewOptions {
  if (!value || typeof value !== "object") return SOLO_VIEW_DEFAULTS;
  const options = value as SoloViewOptions;
  return {
    group: ["workspace", "status", "none"].includes(options.group)
      ? options.group
      : "workspace",
    sort: ["recent", "name"].includes(options.sort) ? options.sort : "recent",
    show: ["all-chats", "active-tasks", "all-tasks"].includes(options.show)
      ? options.show
      : "all-chats",
  };
}
export const eligibleSolo = (item: ChannelSummary, viewer?: string) =>
  !item.archived &&
  item.channelType === "solo" &&
  (!item.readOnly || ownSolo(item, viewer));
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max;
const channelId = (value: unknown) =>
  text(value, 256) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value as string);
/** Copy bounded plugin data once. Never retain a mutable plugin-owned array. */
export function acceptSoloRows(value: unknown): readonly SoloTaskRow[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid Solo task metadata");
  const ids = new Set<string>();
  return Object.freeze(
    value.map((row: SoloTaskRow) => {
      if (
        !row ||
        !channelId(row.channelId) ||
        ids.has(row.channelId) ||
        !Object.hasOwn(SOLO_STATUS_LABELS, row.status) ||
        (row.parentChannelId !== undefined &&
          !channelId(row.parentChannelId)) ||
        (row.subtitle !== undefined && !text(row.subtitle, 240)) ||
        (row.details !== undefined &&
          (!Array.isArray(row.details) ||
            row.details.length > 4 ||
            row.details.some(
              (detail) =>
                !detail || !text(detail.label, 80) || !text(detail.value, 240),
            )))
      )
        throw new Error("Invalid Solo task metadata");
      ids.add(row.channelId);
      return Object.freeze({
        channelId: row.channelId,
        status: row.status,
        ...(row.parentChannelId !== undefined
          ? { parentChannelId: row.parentChannelId }
          : {}),
        ...(row.subtitle !== undefined ? { subtitle: row.subtitle } : {}),
        ...(row.details
          ? {
              details: Object.freeze(
                row.details.map((detail) =>
                  Object.freeze({ label: detail.label, value: detail.value }),
                ),
              ),
            }
          : {}),
      });
    }),
  );
}
export type SoloForest = Readonly<{
  tasks: ReadonlyMap<string, SoloTaskRow>;
  parents: ReadonlyMap<string, string>;
  children: ReadonlyMap<string, readonly string[]>;
  roots: ReadonlyMap<string, string>;
}>;
/** Unknown/ineligible parents become roots. Reject cycles; do not invent a second normalization rule. */
export function soloForest(
  rows: readonly SoloTaskRow[],
  channels: readonly ChannelSummary[],
  viewer?: string,
): SoloForest {
  const eligible = new Set(
    channels
      .filter((item) => eligibleSolo(item, viewer))
      .map((item) => item.id),
  );
  const tasks = new Map(
    rows
      .filter((row) => eligible.has(row.channelId))
      .map((row) => [row.channelId, row]),
  );
  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const row of tasks.values())
    if (row.parentChannelId && tasks.has(row.parentChannelId)) {
      parents.set(row.channelId, row.parentChannelId);
      children.set(row.parentChannelId, [
        ...(children.get(row.parentChannelId) ?? []),
        row.channelId,
      ]);
    }
  const roots = new Map<string, string>();
  for (const id of tasks.keys()) {
    const seen = new Set<string>();
    let root = id;
    while (parents.has(root)) {
      if (seen.has(root)) throw new Error("Cyclic Solo task metadata");
      seen.add(root);
      root = parents.get(root) ?? root;
    }
    roots.set(id, root);
  }
  return { tasks, parents, children, roots };
}
export function soloAncestors(forest: SoloForest, id?: string): string[] {
  const path: string[] = [];
  let parent = id ? forest.parents.get(id) : undefined;
  while (parent) {
    path.push(parent);
    parent = forest.parents.get(parent);
  }
  return path;
}
export type SoloProjection = Readonly<{
  roots: readonly string[];
  children: ReadonlyMap<string, readonly string[]>;
  included: ReadonlySet<string>;
  context: ReadonlySet<string>;
  outside?: string | undefined;
  excluded: number;
}>;
/** Filters count destinations before caps and disclosure. Host title/activity decide ordering. */
export function projectSolo(
  forest: SoloForest,
  channels: readonly ChannelSummary[],
  options: SoloViewOptions,
  current?: string,
  retained: readonly string[] = [],
): SoloProjection {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const included = new Set<string>();
  const context = new Set<string>();
  for (const channel of channels) {
    const task = forest.tasks.get(channel.id);
    if (
      options.show === "all-chats" ||
      (task && (options.show === "all-tasks" || task.status !== "archived"))
    )
      included.add(channel.id);
  }

  const outside =
    current && byId.has(current) && !included.has(current)
      ? current
      : undefined;
  for (const id of [...(current ? [current] : []), ...retained])
    if (byId.has(id)) included.add(id);
  for (const id of [...included])
    for (const parent of soloAncestors(forest, id)) {
      if (!included.has(parent)) context.add(parent);
      included.add(parent);
    }
  const compare = (a: string, b: string) => {
    const left = byId.get(a);
    const right = byId.get(b);
    if (!left || !right) return a.localeCompare(b);
    return (
      (options.sort === "name"
        ? left.name.localeCompare(right.name)
        : (right.lastActivityAt ?? right.updatedAt ?? 0) -
          (left.lastActivityAt ?? left.updatedAt ?? 0)) || a.localeCompare(b)
    );
  };
  return {
    roots: [...included].filter((id) => !forest.parents.has(id)).sort(compare),
    children: new Map(
      [...forest.children].map(([id, children]) => [
        id,
        children.filter((child) => included.has(child)).sort(compare),
      ]),
    ),
    included,
    context,
    outside,
    excluded: channels.length - included.size,
  };
}
