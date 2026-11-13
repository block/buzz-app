import type { ChannelSummary } from "../../features/relay/contracts";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import { BUILT_IN_SIDEBAR_SECTIONS } from "../../features/relay/sidebar-registers";

export function isChannelSectionKey(key: string) {
  return key === "channels" || key.startsWith("group:");
}

export function isChannelDropSectionKey(key: string) {
  return key === "starred" || isChannelSectionKey(key);
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

function compareName(a: ChannelSummary, b: ChannelSummary) {
  return a.name.toLowerCase() < b.name.toLowerCase()
    ? -1
    : a.name.toLowerCase() > b.name.toLowerCase()
      ? 1
      : a.id.localeCompare(b.id);
}

/** The sidebar's "recent" order: newest activity first, channels without known
 * activity after, then by name. */
export function compareRecent(a: ChannelSummary, b: ChannelSummary) {
  if (
    a.lastActivityAt !== undefined &&
    b.lastActivityAt !== undefined &&
    a.lastActivityAt !== b.lastActivityAt
  )
    return b.lastActivityAt - a.lastActivityAt;
  if (a.lastActivityAt !== undefined && b.lastActivityAt === undefined)
    return -1;
  if (a.lastActivityAt === undefined && b.lastActivityAt !== undefined)
    return 1;
  return compareName(a, b);
}

/** Every section key in display order. A built-in section stays just before
 * the saved group that followed it, so group order stays the groups' own. A
 * group the layout doesn't list yet follows the group before it; a first one
 * goes after the next group's built-ins, or just before Channels. */
export function sidebarLayout(
  groupIds: readonly string[],
  layout?: readonly string[],
): string[] {
  const groups = groupIds.map((id) => `group:${id}`);
  if (!layout) return ["starred", ...groups, "channels", "forums", "dms"];
  const live = new Set(groups);
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  for (const key of layout)
    if (live.has(key)) {
      before.set(key, pending);
      pending = [];
    } else if ((BUILT_IN_SIDEBAR_SECTIONS as readonly string[]).includes(key))
      pending.push(key);
  const result: string[] = [];
  let waiting: string[] = [];
  for (const group of groups) {
    const anchored = before.get(group);
    if (!anchored) {
      if (result.length && !waiting.length) result.push(group);
      else waiting.push(group);
      continue;
    }
    result.push(...anchored, ...waiting, group);
    waiting = [];
  }
  if (!waiting.length) return [...result, ...pending];
  const channels = pending.indexOf("channels");
  return [
    ...result,
    ...pending.slice(0, Math.max(channels, 0)),
    ...waiting,
    ...pending.slice(Math.max(channels, 0)),
  ];
}

/** Preferences only arrange the supplied authorized roster; they never add channels. */
export function sidebarSections<T extends ChannelSummary>(
  channels: readonly T[],
  preferences?: SidebarPreferences,
  hiddenDms: ReadonlySet<string> = new Set(),
) {
  const active = channels.filter(
    (channel) =>
      !channel.archived && (!channel.hidden || channel.channelType === "dm"),
  );
  const streams = active.filter(
    (channel) =>
      channel.channelType !== "dm" && channel.channelType !== "forum",
  );
  const dms = active.filter(
    (channel) => channel.channelType === "dm" && !hiddenDms.has(channel.id),
  );
  const movable = [...streams, ...dms];
  const stars = new Set(preferences?.starred);
  const groups = preferences?.sections ?? [];
  const ids = new Set(groups.map((group) => group.id));
  const assignment = (id: string) => preferences?.assignments[id];
  const sort = (rows: readonly ChannelSummary[], key: string) =>
    [...rows].sort(
      preferences?.sort?.[key] === "recent" ? compareRecent : compareName,
    );
  const position = new Map(
    sidebarLayout(
      groups.map(({ id }) => id),
      preferences?.layout,
    ).map((key, index) => [key, index]),
  );
  return [
    {
      key: "starred",
      title: "Starred",
      icon: undefined,
      rows: sort(
        movable.filter((channel) => stars.has(channel.id)),
        "starred",
      ),
    },
    ...groups.map((group) => ({
      key: `group:${group.id}`,
      title: group.name,
      icon: group.icon,
      rows: sort(
        movable.filter(
          (channel) =>
            !stars.has(channel.id) && assignment(channel.id) === group.id,
        ),
        `section:${group.id}`,
      ),
    })),
    {
      key: "channels",
      title: "Channels",
      icon: undefined,
      rows: sort(
        streams.filter(
          (channel) =>
            !stars.has(channel.id) && !ids.has(assignment(channel.id) ?? ""),
        ),
        "channels",
      ),
    },
    {
      key: "forums",
      title: "Forums",
      icon: undefined,
      rows: sort(
        active.filter((channel) => channel.channelType === "forum"),
        "forums",
      ),
    },
    {
      key: "dms",
      title: "Direct messages",
      icon: undefined,
      rows: sort(
        dms.filter(
          (channel) =>
            !stars.has(channel.id) && !ids.has(assignment(channel.id) ?? ""),
        ),
        "dms",
      ),
    },
  ]
    .sort((a, b) => (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0))
    .filter(
      (section) =>
        isChannelSectionKey(section.key) ||
        section.key === "dms" ||
        section.rows.length,
    );
}
