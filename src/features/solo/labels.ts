import { viewerMember } from "../relay/membership.ts";
import type { ChannelSummary } from "../relay/contracts.ts";

/** Presentation provenance in the relay's existing NIP-CL labels, never access. */
export const SOLO_NAMED_LABEL = "buzz.session.named";
/** NIP-CL label marking a Solo chat: a channel whose owner talks with
 * their agents at top level. Every member and agent reads it from channel
 * metadata. Presentation and composition only; ordinary channel permissions
 * remain the access authority. Conversion to a channel clears it. */
export const SOLO_LABEL = "buzz.solo";

export const SOLO_ACCESS_DISCLOSURE =
  "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.";

export function soloShareDisclosure(multiple = false): string {
  return `Everyone in this community can read ${multiple ? "each chat’s" : "its"} full history, Canvas, workspace folders, and agent instructions.`;
}

/** Switching an open Solo chat to Private never removes its members. */
export function soloRetainedAccessWarning(
  base: Pick<ChannelSummary, "visibility" | "joinRole">,
  mayHaveGuestMembers = true,
  removalLocation: string | null = "People",
): string {
  if (base.visibility !== "public") return "";
  const untilRemoved = `until you remove them${removalLocation ? ` in ${removalLocation}` : ""}.`;
  if (base.joinRole !== "guest")
    return `People who already joined remain members and keep their access ${untilRemoved}`;
  return mayHaveGuestMembers
    ? `People who joined while it was View only are members and keep reading ${untilRemoved}`
    : "";
}

export function soloLabels(labels: readonly string[] | undefined): boolean {
  return !!labels?.includes(SOLO_LABEL);
}

/** The viewer's own Solo chat: one they created. Anyone else in a shared
 * Solo chat sees its flat treatment and finds it with their own chats. */
export function ownSolo(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        creator?: string | undefined;
      }>
    | undefined,
  viewer: string | undefined,
): boolean {
  return (
    channel?.channelType === "solo" && !!viewer && channel.creator === viewer
  );
}

export function soloChatLinkName(channel: { id: string; name: string }) {
  // Unnamed chats still carry their starting title from the first prompt.
  return channel.name.trim() || channel.id.slice(0, 8);
}

/** The title a link to a Solo chat itself reads by, in its conversation and
 * in previews of it, in place of a channel's `#name`; empty for any other
 * link. `channels` is the session's own list: only a chat the relay has
 * confirmed counts, and a retained copy's `cached` can be out of date. */
export function linkedSoloChatName(
  link: { channelId: string; messageId?: string; threadRootId?: string },
  channels:
    | readonly Pick<ChannelSummary, "id" | "name" | "channelType" | "cached">[]
    | undefined,
) {
  if (link.messageId || link.threadRootId) return "";
  const channel = channels?.find((item) => item.id === link.channelId);
  return channel?.channelType === "solo" && !channel.cached
    ? soloChatLinkName(channel)
    : "";
}

/** The authorized Solo inventory; unknown metadata never implies Solo. An
 * unlisted chat belongs to the surface that presents it, not the list. */
export function eligibleSolo(
  channel: ChannelSummary,
  viewer: string | undefined,
) {
  return (
    !channel.archived &&
    !channel.unlisted &&
    channel.channelType === "solo" &&
    (!channel.readOnly ||
      ownSolo(channel, viewer) ||
      (!!viewer &&
        channel.viewerRole === "guest" &&
        viewerMember(channel, viewer)))
  );
}
