import { useEffect, useState, type ReactNode } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { useChannelWindow } from "../../features/relay/react";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Inbox.module.css";

/** One selected conversation window and the same scoped composer used in Channels.
 * The draft preview starts at the returned tail without changing canonical scroll intent. */
export function ChannelPreview({
  session,
  channelId,
  channelName,
  extensions,
  actions,
  exactActions,
  draft = false,
  anchor,
  onSend,
  onClose,
}: {
  session: RelaySession;
  channelId: string;
  channelName: string;
  extensions?: ConversationExtensions | undefined;
  actions: ReactNode;
  exactActions?: ReactNode;
  draft?: boolean;
  anchor?: string | undefined;
  onSend?: (id: string) => void;
  onClose?: () => void;
}) {
  const window = useChannelWindow(session.channels, channelId);
  const [sentId, setSentId] = useState<string>();
  const [opening, setOpening] = useState<{
    anchor: string;
    inTimeline: boolean;
  }>();
  useEffect(() => {
    if (
      !anchor ||
      opening?.anchor === anchor ||
      window.status === "idle" ||
      window.status === "loading"
    )
      return;
    // Same canonical decision as Channels: freeze this attempt after the head
    // settles; later live arrivals must not switch an exact reader's presentation.
    setOpening({
      anchor,
      inTimeline:
        window.status === "ready" &&
        window.freshness !== "cached" &&
        window.rows.some((row) => row.id === anchor && !row.threadRootId),
    });
  }, [anchor, opening, window]);
  const channel = session.channels.get?.(channelId);
  // Selecting a draft asks for the current head, even if a prior channel visit
  // left an older bounded window. The shared store coalesces a head in flight.
  useEffect(() => {
    if (draft) session.channels.refresh?.(channelId);
  }, [session, channelId, draft]);
  // Cache clear can leave the selected window idle without remounting it.
  useEffect(() => {
    if (window.status === "idle") session.channels.ensure(channelId);
  }, [session, channelId, window.status]);
  if (anchor && opening?.anchor === anchor && !opening.inTimeline && onClose)
    return (
      <ThreadPanel
        session={session}
        scope={session.scope}
        extensions={extensions}
        channelId={channelId}
        channelName={channelName}
        messageId={anchor}
        revealSelected
        close={onClose}
        headerActions={exactActions}
        onOpenLink={() => false}
      />
    );
  return (
    <section className={styles.previewFrame} aria-label="Conversation preview">
      <PanelHeader variant="compact" title="Messages" actions={actions} />
      <div className={styles.previewHistory}>
        {window.rows.length > 0 && (
          <ChannelTimeline
            extensions={extensions}
            queries={session}
            scope={session.scope}
            channelId={channelId}
            window={window}
            {...(draft ? { transient: true } : {})}
            revealMessageId={sentId ?? anchor}
            onOpenLink={() => false}
          />
        )}
        {(window.status === "error" || window.error) && (
          <p className={styles.notice} role="alert">
            {window.error ?? "Could not load conversation."}
          </p>
        )}
        {(window.status === "error" || window.error) && (
          <div className={styles.notice}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => session.channels.refresh?.(channelId)}
            >
              Retry conversation
            </Button>
          </div>
        )}
        {window.status === "ready" && !window.error && !window.rows.length && (
          <p className={styles.notice} role="status">
            No messages yet.
          </p>
        )}
        {(window.status === "idle" || window.status === "loading") &&
          !window.error &&
          !window.rows.length && (
            <p className={styles.notice} role="status">
              Loading conversation…
            </p>
          )}
      </div>
      <MessageComposer
        session={session}
        scope={session.scope}
        extensions={extensions}
        channelId={channelId}
        channelName={channelName}
        label={
          channel?.channelType === "dm"
            ? `Message ${channelName}`
            : `Message #${channelName}`
        }
        sessionConversation={channel?.channelType === "session"}
        onSend={(id) => {
          setSentId(id);
          onSend?.(id);
        }}
      />
    </section>
  );
}
