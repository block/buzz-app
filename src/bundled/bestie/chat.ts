import { viewerMember } from "../../features/relay/membership";
import type { ChannelSummary } from "../../features/relay/contracts";

/** The verified one-to-one DM with this Bestie. Solo chats stay separate.
 * The DM `shown` stays the chat while the viewer and the Bestie are both in
 * it, so someone joining it never takes the chat, or a send in it, away. */
export function bestieChat(
  channels: readonly ChannelSummary[],
  viewer: string | undefined,
  bestie: string | undefined,
  shown?: string,
) {
  if (!viewer || !bestie) return;
  const live = channels.filter(
    (channel) =>
      channel.channelType === "dm" &&
      !channel.cached &&
      !channel.archived &&
      viewerMember(channel, viewer),
  );
  const kept = live.find(
    (channel) => channel.id === shown && channel.members?.includes(bestie),
  );
  if (kept) return kept;
  return live
    .filter((channel) => onlyOther(channel.members, viewer) === bestie)
    .sort(
      (a, b) =>
        recency(b) - recency(a) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .at(0);
}

const recency = (channel: ChannelSummary) =>
  channel.lastActivityAt ?? channel.createdAt ?? 0;

function onlyOther(members: readonly string[] | undefined, viewer: string) {
  if (!members) return;
  const others = [...new Set(members)].filter((key) => key !== viewer);
  return others.length === 1 ? others[0] : undefined;
}
