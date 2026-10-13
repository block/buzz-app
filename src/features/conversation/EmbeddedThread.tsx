import { useSyncExternalStore } from "react";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../messages/MessageManagement";
import { ThreadPanel, type ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";
import {
  ConversationHost,
  type ConversationHostServices,
} from "./ConversationHost";

/** The host owns conversation behavior; the page owns its task and placement. */
export type EmbeddedThreadProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "messageId"
>;
type Props = EmbeddedThreadProps & {
  host: ConversationHostServices;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};

/** Channel visits and recovery span threads; overlays belong to one thread. */
export function EmbeddedThread(props: Props) {
  const { session, scope, channelId, messageId } = props;
  const { channels } = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  return (
    <MessageManagement
      key={messageViewKey(session, scope, channelId)}
      session={session}
      channelId={channelId}
    >
      <MessageManagementStatus />
      <ConversationHost key={messageId} {...props} threadId={messageId}>
        {(interactions) => (
          <ThreadPanel
            {...props}
            {...interactions}
            sessionConversation={channels.some(
              (channel) =>
                channel.id === channelId && channel.channelType === "session",
            )}
          />
        )}
      </ConversationHost>
    </MessageManagement>
  );
}
