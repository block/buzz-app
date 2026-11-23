import { useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useReplyPlacement } from "../../features/messages/reply-placement";
import {
  conversationOthers,
  conversationPeople,
  isSoloConversation,
} from "./ConversationIdentity";

const noSubscription = () => () => {};
const none = new Map();
const noProfiles = () => none;

/**
 * "Reply in thread" for a conversation's own composer. It starts checked
 * when other people are in the conversation, or may join and post, so agents
 * answer in a thread; with only you and your agents, they answer at the top
 * level. The same people rule draws the conversation's icon.
 */
export function useConversationReplyPlacement(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  const profiles = useSyncExternalStore(
    session.profiles?.subscribe ?? noSubscription,
    session.profiles?.snapshot ?? noProfiles,
  );
  const suggested =
    !!channel &&
    (channel.channelType === "dm"
      ? conversationPeople(
          conversationOthers(channel, session.viewer),
          profiles,
        ).length > 0
      : !isSoloConversation(channel, session.viewer, profiles));
  const reply = useReplyPlacement(channel?.id, "top", suggested);
  return {
    replyPlacement: reply.placement,
    replyChoice: reply,
    sent: reply.sent,
  };
}
