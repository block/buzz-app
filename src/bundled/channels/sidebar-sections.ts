import type { ChannelSummary } from "../../features/relay/contracts";
import {
  isSidebarPluginCardKey,
  MAX_SIDEBAR_PLUGIN_CARDS,
  SIDEBAR_PAGES_SECTION,
  workspaceSectionOrder,
  type SidebarPreferences,
} from "../../features/relay/sidebar-preferences";
import { defaultSidebarSort } from "../../features/relay/sidebar-sort";
import type { SidebarCardOrder } from "../../features/channel-navigation/ChannelSidebarDnd";

export function isChannelSectionKey(key: string) {
  return key === "channels" || key.startsWith("group:");
}

export type SidebarRowKind = "channel" | "dm" | "solo" | "forum";

const anyRow: readonly SidebarRowKind[] = ["solo", "channel", "forum", "dm"];
const homeRows: Partial<Record<string, readonly SidebarRowKind[]>> = {
  solo: ["solo"],
  channels: ["channel", "forum"],
  dms: ["dm"],
};

export function sidebarDropRowKinds(key: string): readonly SidebarRowKind[] {
  return key === "starred" || key.startsWith("group:")
    ? anyRow
    : (homeRows[key] ?? []);
}

export function sidebarRowKind(channel: ChannelSummary): SidebarRowKind {
  const kind = channel.channelType;
  return kind === "solo" || kind === "dm" || kind === "forum"
    ? kind
    : "channel";
}

export function sidebarHome(channel: ChannelSummary) {
  const kind = sidebarRowKind(channel);
  return kind === "channel" || kind === "forum"
    ? "channels"
    : kind === "dm"
      ? "dms"
      : kind;
}

export function contributedSidebarSectionKey(key: string) {
  return `plugin:${key}`;
}

export function orderContributedSidebarSections<T extends { key: string }>(
  sections: readonly T[],
  order: readonly string[],
) {
  const position = new Map(order.map((key, index) => [key, index]));
  return sections
    .map((section, index) => ({ section, index }))
    .sort(
      (a, b) =>
        (position.get(a.section.key) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.section.key) ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ section }) => section);
}

/** The sidebar's one card order over the cards shown, given in their default
 * order. Saved cards keep their places; this device's earlier plugin order
 * ranks plugin cards the synced order hasn't saved. */
export function sidebarCardOrder(
  groups: Pick<SidebarPreferences, "sections" | "sectionOrder"> | undefined,
  shown: readonly string[],
  localOrder: readonly string[],
  writable: boolean,
  save: (key: string, order: readonly string[]) => Promise<unknown>,
): SidebarCardOrder {
  const plugins = orderContributedSidebarSections(
    shown.filter(isSidebarPluginCardKey).map((key) => ({ key })),
    localOrder,
  ).map(({ key }) => key);
  // Cards past the saved limit stay listed, last, without moving.
  let cards = 0;
  const order = workspaceSectionOrder(groups, plugins).filter(
    (key) =>
      !isSidebarPluginCardKey(key) || ++cards <= MAX_SIDEBAR_PLUGIN_CARDS,
  );
  const listed = new Set(shown);
  return {
    order,
    shown: order.filter((key) => listed.has(key)),
    writable,
    reorder(key: string, overKey: string) {
      const to = order.indexOf(overKey);
      if (to < 0 || !order.includes(key)) return;
      const next = order.filter((id) => id !== key);
      next.splice(to, 0, key);
      void save(key, next).catch(() => {});
    },
  };
}

function compareName(a: ChannelSummary, b: ChannelSummary) {
  return a.name.toLowerCase() < b.name.toLowerCase()
    ? -1
    : a.name.toLowerCase() > b.name.toLowerCase()
      ? 1
      : a.id.localeCompare(b.id);
}

/** The sidebar's "recent" order: newest activity first, counting at least from
 * creation so a chat just started leads before its first message lands and
 * cannot step backward when that message is acknowledged. Channels with
 * neither follow, then by name. */
export function recentAt(channel: ChannelSummary) {
  return channel.lastActivityAt !== undefined && channel.createdAt !== undefined
    ? Math.max(channel.lastActivityAt, channel.createdAt)
    : (channel.lastActivityAt ?? channel.createdAt);
}

export function compareRecent(a: ChannelSummary, b: ChannelSummary) {
  const at = recentAt(a);
  const bt = recentAt(b);
  if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
  if (at !== undefined && bt === undefined) return -1;
  if (at === undefined && bt !== undefined) return 1;
  return compareName(a, b);
}

const titles: Record<string, string> = {
  pages: "Plugins",
  starred: "Favorites",
  solo: "Solo",
  channels: "Team",
  dms: "Direct messages",
};

/** Preferences only arrange the supplied authorized roster; they never add channels. */
export function sidebarSections<T extends ChannelSummary>(
  channels: readonly T[],
  preferences?: SidebarPreferences,
  hiddenDms: ReadonlySet<string> = new Set(),
  chatsOnly = false,
  draftSections: ReadonlySet<string> = new Set(),
  dormantAssignments: ReadonlySet<string> = new Set(),
  /** Include the orderable Plugins section for sidebar-placed pages. */
  pages = false,
) {
  const groups = new Map(
    preferences?.sections.map((group) => [group.id, group]),
  );
  const stars = new Set(preferences?.starred);
  const rowsBySection = new Map<string, T[]>();
  for (const channel of channels) {
    if (
      channel.archived ||
      (channel.channelType === "dm"
        ? hiddenDms.has(channel.id)
        : channel.hidden) ||
      (chatsOnly && channel.channelType !== "solo")
    )
      continue;
    const destination = dormantAssignments.has(channel.id)
      ? undefined
      : preferences?.assignments[channel.id];
    const key = stars.has(channel.id)
      ? "starred"
      : destination && groups.has(destination)
        ? `group:${destination}`
        : sidebarHome(channel);
    const rows = rowsBySection.get(key);
    if (rows) rows.push(channel);
    else rowsBySection.set(key, [channel]);
  }
  return workspaceSectionOrder(preferences).flatMap((key) => {
    if (key === SIDEBAR_PAGES_SECTION && !pages) return [];
    const group = groups.get(key.slice(6));
    const rows = rowsBySection.get(key) ?? [];
    // The Solo heading owns New and its keyboard shortcut, even when every
    // chat is filed in a workspace. Plugins stay reachable in Focus.
    if (
      chatsOnly &&
      key !== "solo" &&
      key !== SIDEBAR_PAGES_SECTION &&
      !rows.length &&
      !draftSections.has(key)
    )
      return [];
    const mode = preferences?.sort?.[group ? `section:${group.id}` : key];
    rows.sort(
      (mode ?? defaultSidebarSort(key)) === "recent"
        ? compareRecent
        : compareName,
    );
    return [
      {
        key,
        title: group?.name ?? titles[key] ?? key,
        icon: group?.icon,
        rows,
      },
    ];
  });
}
