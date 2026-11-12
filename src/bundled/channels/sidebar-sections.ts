import type { ChannelSummary } from "../../features/relay/contracts";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import type { SidebarGroupPosition } from "../../features/channel-navigation/sidebar-sections-service";

export const soloGroupKey = "scope:solo";
export const teamGroupKey = "scope:team";

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

/**
 * Top-level groups follow the saved order. A group the person has not placed
 * yet goes by its hint: `start` before the saved groups, `end` after them.
 * Groups with no hint, the built-in ones, sit between the two.
 */
export function orderSidebarGroups<
  T extends { key: string; position?: SidebarGroupPosition | undefined },
>(groups: readonly T[], saved: readonly string[]) {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const placed = [...new Set(saved)]
    .map((key) => byKey.get(key))
    .filter((group): group is T => !!group);
  const unplaced = groups.filter((group) => !placed.includes(group));
  const hinted = (position: SidebarGroupPosition | undefined) =>
    unplaced.filter((group) => group.position === position);
  return [
    ...hinted("start"),
    ...placed,
    ...hinted(undefined),
    ...hinted("end"),
  ];
}

/**
 * Moves `key` to where `overKey` sits among the `active` keys, then writes the
 * result back into the saved order. Saved keys that are not active stay in
 * their slots, so a disabled plugin returns to its place.
 */
export function reorderSavedSectionKeys(
  active: readonly string[],
  saved: readonly string[],
  key: string,
  overKey: string,
) {
  const ids = [...active];
  const from = ids.indexOf(key);
  const to = ids.indexOf(overKey);
  if (from < 0 || to < 0) return undefined;
  ids.splice(from, 1);
  ids.splice(to, 0, key);
  const activeKeys = new Set(ids);
  const seenSavedKeys = new Set<string>();
  const order: string[] = [];
  let nextActive = 0;
  for (const savedKey of saved) {
    if (!activeKeys.has(savedKey)) {
      order.push(savedKey);
      continue;
    }
    if (seenSavedKeys.has(savedKey)) continue;
    seenSavedKeys.add(savedKey);
    order.push(ids[nextActive++] ?? savedKey);
  }
  order.push(...ids.slice(nextActive));
  return order;
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
  ].filter(
    (section) =>
      isChannelSectionKey(section.key) ||
      section.key === "dms" ||
      section.rows.length,
  );
}
