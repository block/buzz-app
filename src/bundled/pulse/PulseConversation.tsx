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
export function PulseConversation({
  session,
  scope,
  channelId,
  name,
  extensions,
  back,
  initialThread,
}: {
  session: RelaySession;
  scope: string;
  channelId: string;
  name: string;
  extensions?: ConversationExtensions | undefined;
  back(): void;
  initialThread?: string | undefined;
}) {
  const window = useChannelWindow(session.channels, channelId);
  const [thread, setThread] = useState(initialThread);
  const [sent, setSent] = useState<string>();
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
            session={session}
            scope={scope}
            channelId={channelId}
            channelName={name}
            messageId={thread}
            extensions={extensions}
            close={() => setThread(undefined)}
            onOpenLink={openLink}
          />
        </div>
      ) : (
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
              queries={session}
              scope={scope}
              channelId={channelId}
              window={window}
              extensions={extensions}
              onOpenLink={openLink}
              onOpenThread={setThread}
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
      )}
    </div>
  );
}
