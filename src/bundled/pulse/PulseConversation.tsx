import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { useChannelWindow } from "../../features/relay/react";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import styles from "./Pulse.module.css";
const openLink = () => false;
type ConversationProps = {
  session: RelaySession;
  viewer?: string | undefined;
  scope: string;
  channelId: string;
  name: string;
  extensions?: ConversationExtensions | undefined;
  back(): void;
  thread?: string | undefined;
  openThread(id: string): void;
};

export function PulseConversation({
  session,
  viewer,
  scope,
  channelId,
  name,
  extensions,
  back,
  thread,
  openThread,
}: ConversationProps) {
  return (
    <div className={styles.detail}>
      <header className={styles.heading}>
        <button type="button" onClick={back} aria-label="Back to Pulse">
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <strong>{name}</strong>
      </header>
      {thread ? (
        <div className={styles.threadHost}>
          <ThreadPanel
            presentation="bubbles"
            viewer={viewer}
            session={session}
            scope={scope}
            channelId={channelId}
            channelName={name}
            messageId={thread}
            extensions={extensions}
            close={back}
            onOpenLink={openLink}
          />
        </div>
      ) : (
        <PulseChannelMessages
          session={session}
          viewer={viewer}
          scope={scope}
          channelId={channelId}
          name={name}
          extensions={extensions}
          onOpenThread={openThread}
        />
      )}
    </div>
  );
}

// Direct thread entry owns only the thread reader; do not also open a channel window.
function PulseChannelMessages({
  session,
  viewer,
  scope,
  channelId,
  name,
  extensions,
  onOpenThread,
}: Omit<ConversationProps, "back" | "thread" | "openThread"> & {
  onOpenThread(id: string): void;
}) {
  const window = useChannelWindow(session.channels, channelId);
  const [sent, setSent] = useState<string>();
  return (
    <>
      {window.status === "error" && !window.rows.length ? (
        <div className={styles.empty} role="alert">
          <p>{window.error}</p>
          <button
            type="button"
            onClick={() => session.channels.ensure(channelId)}
          >
            Retry messages
          </button>
        </div>
      ) : window.status !== "ready" && !window.rows.length ? (
        <p className={styles.empty} role="status">
          Loading messages…
        </p>
      ) : (
        <ChannelTimeline
          presentation="bubbles"
          viewer={viewer}
          queries={session}
          scope={scope}
          channelId={channelId}
          window={window}
          extensions={extensions}
          onOpenLink={openLink}
          onOpenThread={onOpenThread}
          revealMessageId={sent}
        />
      )}
      <MessageComposer
        session={session}
        scope={scope}
        channelId={channelId}
        channelName={name}
        extensions={extensions}
        onSend={setSent}
      />
    </>
  );
}
