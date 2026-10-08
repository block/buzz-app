import { useEffect } from "react";
import type { Conversation } from "../../features/conversation/service";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { useChannelList, useChannelWindow } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";

export function BestieChat({
  session,
  scope,
  owner,
  channelId,
  agentPubkey,
  conversation,
}: {
  session: RelaySession;
  scope: string;
  owner: string;
  channelId: string;
  agentPubkey: string;
  conversation: Conversation;
}) {
  const window = useChannelWindow(session.channels, channelId);
  const list = useChannelList(session.channels);
  const channel = list.channels.find((item) => item.id === channelId);
  const privateChat =
    session.viewer === owner &&
    channel?.channelType === "session" &&
    channel.visibility === "private" &&
    !channel.cached &&
    !channel.archived &&
    !channel.readOnly &&
    channel.members?.includes(owner) &&
    channel.members.includes(agentPubkey) &&
    channel.members.every((key) => key === owner || key === agentPubkey);
  useEffect(() => {
    session.profiles.ensure([agentPubkey]);
  }, [session, agentPubkey]);
  return (
    <MessageManagement
      session={session}
      channelId={channelId}
      active={!!privateChat}
    >
      <MessageManagementStatus />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          <ChannelTimeline
            channelId={channelId}
            scope={scope}
            viewer={owner}
            queries={session}
            window={window}
            extensions={conversation}
            onOpenLink={() => false}
          />
        </div>
        {!privateChat && (
          <p role="alert" className="px-6 py-3 text-body-sm text-muted">
            Confirming your private Bestie conversation. Reconnect if it stays
            unavailable.
          </p>
        )}
        <conversation.ui.Composer
          session={session}
          scope={scope}
          channelId={channelId}
          channelName="Bestie"
          label="Message Bestie"
          placeholder="Tell Bestie what’s on your mind…"
          sessionConversation
          // Bestie is this session's only agent, so routing needs no picker.
          trailingTool={false}
          disabled={!privateChat}
        />
      </div>
    </MessageManagement>
  );
}
