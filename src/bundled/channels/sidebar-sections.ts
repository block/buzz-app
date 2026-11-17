import type { ChannelSummary } from "../../features/relay/contracts";

export function contributedSidebarSectionKey(key: string) {
  return `plugin:${key}`;
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
