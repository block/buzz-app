import { Service, type Context } from "@deepseek-ai/cordis";
import type { ReactElement } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type { UnreadSnapshot } from "../relay/unread";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import { isSidebarSortMode, type SidebarSortMode } from "../relay/sidebar-sort";

export type SidebarRow = Readonly<{
  id: string;
  kind: "team" | "dm" | "solo";
  label: string;
  /** Team: the section key. Solo: the workspace id, or "" for unfiled chats. */
  sectionKey: string;
  channel: ChannelSummary;
  unread: UnreadSnapshot;
  /** An agent is currently working in the channel. */
  working: boolean;
}>;
export type SidebarRowGroup = Readonly<{ id: string; label: string }>;
export type SidebarRowSortMode = Readonly<{
  id: string;
  label: string;
  compare: (a: SidebarRow, b: SidebarRow) => number;
}>;
export type SidebarRowContribution = Readonly<{
  version: 1;
  id: string;
  render?: (
    row: SidebarRow,
    Default: ReactElement | null,
  ) => ReactElement | null;
  sortModes?: readonly SidebarRowSortMode[];
  /** Solo only: rows sharing a group id fold under one collapsible heading. */
  group?: (row: SidebarRow) => SidebarRowGroup | null | undefined;
}>;
export type RegisteredSidebarRows = Contribution<SidebarRowContribution>;
export type SidebarRows = Readonly<{
  version: 1;
  snapshot: () => readonly RegisteredSidebarRows[];
  subscribe: (listener: () => void) => () => void;
  settled?: () => boolean;
  register: (contribution: SidebarRowContribution) => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read through reflect for compatibility with hosts without row contributions. */
    sidebarRows?: SidebarRows;
  }
}

const idPattern = /^[a-z0-9][a-z0-9._-]*$/;

export class SidebarRowsService extends Service implements SidebarRows {
  readonly version = 1 as const;
  private readonly contributions;
  private source: readonly RegisteredSidebarRows[] = [];
  private ordered: readonly RegisteredSidebarRows[] = [];

  constructor(ctx: Context) {
    super(ctx, "sidebarRows");
    this.contributions = createContributions<SidebarRowContribution>(ctx);
  }

  snapshot = () => {
    const source = this.contributions.snapshot();
    if (source !== this.source) {
      this.source = source;
      this.ordered = Object.freeze(
        [...source].sort((a, b) =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
        ),
      );
    }
    return this.ordered;
  };
  settled = () => this.ctx.pluginStatus.settled?.() ?? true;
  subscribe = (listener: () => void) => {
    const contributions = this.contributions.subscribe(listener);
    // A failed plugin can settle without changing the contribution snapshot.
    const status = this.ctx.pluginStatus.subscribe(listener);
    return () => {
      contributions();
      status();
    };
  };

  register(value: SidebarRowContribution) {
    if (value?.version !== 1) {
      console.warn("Ignoring unsupported sidebar row contribution version");
      return;
    }
    if (
      typeof value.id !== "string" ||
      !idPattern.test(value.id) ||
      (value.render !== undefined && typeof value.render !== "function") ||
      (value.group !== undefined && typeof value.group !== "function") ||
      (value.sortModes !== undefined &&
        (!Array.isArray(value.sortModes) ||
          new Set(value.sortModes.map((mode) => mode?.id)).size !==
            value.sortModes.length ||
          value.sortModes.some(
            (mode) =>
              !mode ||
              typeof mode.id !== "string" ||
              !idPattern.test(mode.id) ||
              typeof mode.label !== "string" ||
              !mode.label.trim() ||
              typeof mode.compare !== "function",
          )))
    )
      throw new Error("Invalid sidebar row contribution");
    for (const mode of value.sortModes ?? []) {
      if (
        !isSidebarSortMode(
          `plugin:${this.ctx.pluginOwner?.id}/${value.id}/${mode.id}`,
        )
      )
        throw new Error("Invalid sidebar row sort id");
    }
    this.contributions.register(this.ctx, value);
  }
}

export function sidebarRow(
  channel: ChannelSummary,
  sectionKey: string,
  unread: UnreadSnapshot,
  working = false,
): SidebarRow {
  return {
    id: channel.id,
    kind:
      channel.channelType === "dm"
        ? "dm"
        : channel.channelType === "solo"
          ? "solo"
          : "team",
    label: channel.name,
    sectionKey,
    channel,
    unread,
    working,
  };
}

export function sidebarRowSortModes(entries: readonly RegisteredSidebarRows[]) {
  return entries.flatMap((entry) =>
    (entry.sortModes ?? []).map((mode) => ({
      ...mode,
      id: `plugin:${entry.key}/${mode.id}` as SidebarSortMode,
    })),
  );
}

export function sortSidebarRows<T>(
  rows: readonly T[],
  mode: SidebarRowSortMode | undefined,
  data: (row: T) => SidebarRow,
): readonly T[] {
  if (!mode) return rows;
  try {
    return [...rows].sort((a, b) => {
      const order = mode.compare(data(a), data(b));
      if (!Number.isFinite(order))
        throw new Error("Invalid sidebar row comparison");
      return order;
    });
  } catch {
    return rows;
  }
}

/**
 * Annotates rows with the first valid group a contribution returns, then
 * gathers each group's rows at its first member's position. Rows are never
 * dropped; a throwing or invalid callback is ignored for that row.
 */
export function groupSidebarRows<T>(
  rows: readonly T[],
  entries: readonly RegisteredSidebarRows[],
  data: (row: T) => SidebarRow,
): readonly Readonly<{ row: T; group?: SidebarRowGroup }>[] {
  type Item = Readonly<{ row: T; group?: SidebarRowGroup }>;
  const grouping = entries.filter((entry) => entry.group);
  if (!grouping.length) return rows.map((row) => ({ row }));
  const annotated = rows.map((row): Item => {
    for (const entry of grouping) {
      try {
        const group = entry.group?.(data(row));
        if (
          group &&
          typeof group.id === "string" &&
          idPattern.test(group.id) &&
          typeof group.label === "string" &&
          group.label.trim()
        )
          return { row, group: { id: group.id, label: group.label } };
      } catch {
        // An invalid group leaves the row ungrouped by that contribution.
      }
    }
    return { row };
  });
  const emitted = new Set<string>();
  return annotated.flatMap((item): Item[] => {
    const group = item.group;
    if (!group) return [item];
    if (emitted.has(group.id)) return [];
    emitted.add(group.id);
    return annotated
      .filter((member) => member.group?.id === group.id)
      .map((member) => ({ row: member.row, group }));
  });
}
