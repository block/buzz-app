import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ChannelTimeline } from "../messages/ChannelTimeline";
import { MessageComposer } from "../messages/MessageComposer";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../messages/MessageManagement";
import { ThreadPanel } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";
import { useChannelWindow } from "../relay/react";
import {
  EmbeddedConversation,
  type EmbeddedConversationProps,
  type EmbeddedThreadProps,
} from "./EmbeddedThread";
import styles from "./EmbeddedChannel.module.css";

/** The host owns the channel view; the page owns its task and placement. */
export type EmbeddedChannelProps = Pick<
  EmbeddedThreadProps,
  "session" | "scope" | "channelId" | "channelName"
> & {
  /** A top-level message to show and focus in place. */
  messageId?: string | undefined;
  /** Without it, messages show no reply or thread controls. */
  onOpenThread?(messageId: string, threadRootId: string): void;
};
type Props = EmbeddedChannelProps & {
  host: Context;
  extensions: EmbeddedConversationProps["extensions"];
};

/**
 * The Channels message list and composer of one channel. Message recovery spans
 * the channel; retargeting the message remounts only the view and its overlay.
 */
export function EmbeddedChannel({ host, extensions, ...props }: Props) {
  const { session, scope, channelId, channelName, messageId } = props;
  return (
    <MessageManagement
      key={messageViewKey(session, scope, channelId)}
      session={session}
      channelId={channelId}
    >
      <MessageManagementStatus />
      <EmbeddedConversation
        key={messageId ?? ""}
        host={host}
        extensions={extensions}
        session={session}
        scope={scope}
        channelId={channelId}
        channelName={channelName}
      >
        {(conversation) => <ChannelView {...props} {...conversation} />}
      </EmbeddedConversation>
    </MessageManagement>
  );
}

function ChannelView({
  session,
  scope,
  channelId,
  channelName,
  messageId,
  onOpenThread,
  active,
  ...conversation
}: EmbeddedChannelProps & EmbeddedConversationProps) {
  const window = useChannelWindow(session.channels, channelId);
  // Cache clear can leave the window idle without remounting this view.
  useEffect(() => {
    if (window.status === "idle") session.channels.ensure(channelId);
  }, [session, channelId, window.status]);
  const [target, setTarget] = useState<AbortSignal>();
  useEffect(() => {
    if (!messageId) return;
    const request = new AbortController();
    setTarget(request.signal);
    return () => request.abort();
  }, [messageId]);
  // As in Channels and Inbox, decide once the head settles: a message outside
  // the loaded window opens as its thread, and later arrivals do not switch it.
  const [inTimeline, setInTimeline] = useState<boolean>();
  if (
    messageId &&
    inTimeline === undefined &&
    window.status !== "idle" &&
    window.status !== "loading"
  )
    setInTimeline(
      window.status === "ready" &&
        window.freshness !== "cached" &&
        window.rows.some((row) => row.id === messageId && !row.threadRootId),
    );
  const [sent, setSent] = useState<string>();
  if (messageId && inTimeline === false)
    return (
      <ThreadPanel
        {...conversation}
        session={session}
        scope={scope}
        channelId={channelId}
        channelName={channelName}
        messageId={messageId}
        revealSelected
      />
    );
  return (
    <section
      className={styles.channel}
      aria-label={`Messages in ${channelName}`}
    >
      {window.rows.length > 0 ? (
        <ChannelTimeline
          extensions={conversation.extensions}
          queries={session}
          scope={scope}
          viewer={scope.slice(-64)}
          channelId={channelId}
          window={window}
          // Channels keeps its own saved place in this channel.
          transient
          revealMessageId={sent}
          inlineTarget={
            messageId && target && !target.aborted
              ? { messageId, signal: target }
              : undefined
          }
          onOpenLink={conversation.onOpenLink}
          canOpenLink={conversation.canOpenLink}
          onOpenMediaReview={conversation.onOpenMediaReview}
          {...(onOpenThread
            ? {
                onOpenThread: (id: string, rootId: string) => {
                  if (active()) onOpenThread(id, rootId);
                },
              }
            : {})}
        />
      ) : window.status === "error" ? null : (
        <p className={styles.notice} role="status">
          {window.status === "ready" ? "No messages yet." : "Loading messages…"}
        </p>
      )}
      {(window.status === "error" || window.error) && (
        <div className={styles.notice} role="alert">
          <span>{window.error ?? "Could not load messages."}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => session.channels.refresh?.(channelId)}
          >
            Retry messages
          </Button>
        </div>
      )}
      <MessageComposer
        extensions={conversation.extensions}
        sessionConversation={conversation.sessionConversation}
        onOpenLink={conversation.onOpenLink}
        canOpenLink={conversation.canOpenLink}
        session={session}
        scope={scope}
        channelId={channelId}
        channelName={channelName}
        label={
          conversation.sessionConversation ? "Message this session" : undefined
        }
        onSend={setSent}
      />
    </section>
  );
}
