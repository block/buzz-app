import type { ChannelSummary } from "../relay/contracts";
import type { RelayData } from "../relay/service";
import { replyPlacement } from "../relay/thread-reference";
import { isSoloConversation } from "../relay/conversation-people";

const noProfiles = new Map();

/** Whether a native agent's mention continues a conversation only its owner
 * and their agents can post in: one channel-scoped session. The people rule
 * decides, not the older Solo tag, which counts only while the roster is
 * unknown. A channel not yet known fails rather than guess the routing.
 * Callers freeze the answer for the turn it admits. */
export async function soloChat(
  relay: () => RelayData | undefined,
  owner: string,
  channelId: string,
  signal: AbortSignal,
) {
  const snapshot = relay()?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner) return false;
  signal.throwIfAborted();
  const { channels } = snapshot.session;
  const list = channels.list();
  const channel =
    channels.get?.(channelId) ??
    list.channels.find(({ id }) => id === channelId);
  if (!channel && list.status !== "ready")
    throw new Error(
      `Couldn't read this community's channels to tell where to answer (${list.error ?? "not loaded"}). Try again.`,
    );
  if (!channel) return false;
  const profiles = snapshot.session.profiles?.snapshot?.() ?? noProfiles;
  return isSoloConversation(channel, owner, profiles);
}

/** The people rule for a channel already in hand: only `owner` and their
 * agents can post in it. Profiles not yet loaded count as people. */
export function ownerAndAgentsOnly(
  relay: () => RelayData | undefined,
  owner: string,
  channel: ChannelSummary | undefined,
) {
  const snapshot = relay()?.snapshot();
  if (!channel || snapshot?.status !== "ready") return false;
  const profiles = snapshot.session.profiles?.snapshot?.() ?? noProfiles;
  return isSoloConversation(channel, owner, profiles);
}

/** Whether a turn answers at the channel's top level. A delivered message's
 * reply placement decides; a message without one answers at top level only
 * where only the owner and their agents post. A wake keeps its own placement. */
export function answersAtTopLevel(
  event: { readonly tags: readonly (readonly string[])[] },
  solo: boolean,
  wake?: { readonly topLevel?: boolean | undefined } | undefined,
) {
  if (wake) return solo || wake.topLevel === true;
  const placement = replyPlacement(event);
  return placement ? placement === "top" : solo;
}
