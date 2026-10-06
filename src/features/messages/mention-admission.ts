import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { MentionRecipient } from "./mention-draft";
import { archiveHides } from "../relay/identity-archives";

/** The shared archive discovery rule applied to mention recipients. */
export function archivedMention(session: RelaySession, pubkey: string) {
  return archiveHides(session.archives, pubkey, session.viewer);
}

/**
 * Whether a destination can name people outside it from the community
 * directory. A session cannot: its mentions admit agents through the session
 * choice policy. This follows the channel type, not composer props, because
 * some session composers (media comments, edits) do not carry session mode.
 */
export function allowsOutsideMentions(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
) {
  return !!channel && channel.channelType !== "session";
}

/**
 * Whether a draft may address this key. The host owns this rule; what a
 * chooser offers, its order and its labels belong to the mentions plugin.
 * Delivery checks membership again and asks before addressing outside people.
 */
export function mentionAdmits(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
) {
  if (!/^[0-9a-f]{64}$/.test(pubkey) || archivedMention(session, pubkey))
    return false;
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  if (channel?.archived || channel?.readOnly) return false;
  if (roster) return roster.some((person) => person.pubkey === pubkey);
  if (channel?.members?.includes(pubkey)) return true;
  if (inviteAgents)
    return (
      channel?.channelType !== "dm" &&
      session.agentChoices
        .snapshot()
        .identities.some((agent) => agent.pubkey === pubkey)
    );
  return allowsOutsideMentions(channel);
}
