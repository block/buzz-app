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
 * Which keys a draft may address in this destination, read once from current
 * state. The host owns this rule; the mentions plugin offers a subset of it and
 * owns its order and labels. Delivery checks membership again and asks before
 * addressing outside people.
 */
export function mentionAdmission(
  session: RelaySession,
  channelId: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
): (pubkey: string) => boolean {
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  if (channel?.archived || channel?.readOnly) return () => false;
  const allowed = roster
    ? new Set(roster.map((person) => person.pubkey))
    : new Set(channel?.members);
  if (!roster && inviteAgents && channel?.channelType !== "dm")
    for (const agent of session.agentChoices.snapshot().identities)
      allowed.add(agent.pubkey);
  const outside = !roster && !inviteAgents && allowsOutsideMentions(channel);
  return (pubkey) =>
    /^[0-9a-f]{64}$/.test(pubkey) &&
    !archivedMention(session, pubkey) &&
    (outside || allowed.has(pubkey));
}
