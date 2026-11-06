import { useEffect, useRef, useState } from "react";
import {
  ConversationChannel,
  ConversationComposer,
  ConversationThread,
  ConversationTimeline,
  useConversation,
} from "../conversation/Conversation";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import type { ConversationExtensions } from "../conversation/contracts";
import { MessageEditScope } from "../messages/MessageEditScope";
import { mentionDraft } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import { useChannelWindow } from "../relay/react";
import { readView, viewRevision } from "../../shared/view-state";
import { writeClipboardText } from "../../shared/clipboard";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import {
  ArrowSquareOutIcon,
  ChatCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import type { Entry } from "./model";
import styles from "./DraftsSent.module.css";

export function DraftPreview({
  entry,
  mode = "draft",
  title,
  channel,
  loading = false,
  session,
  host,
  extensions,
  autoFocus,
  onClose,
  onOpen,
  onSaved,
}: {
  entry: Entry;
  mode?: "draft" | "sent";
  title: string;
  channel: ChannelSummary | undefined;
  loading?: boolean;
  session: RelaySession;
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
  autoFocus: boolean;
  onClose(): void;
  onOpen(): void;
  onSaved(restoreFocus: boolean): void;
}) {
  const region = useRef<HTMLElement>(null);
  const [sent, setSent] = useState<string>();
  const sending = useRef<string | undefined>(undefined);
  const [received, setReceived] = useState<string>();
  // Receipts include fast echoes already retired from the pending outbox.
  // Observe delivery only; the composer still owns saving and recovery.
  useEffect(() => {
    let live = true;
    const stop = session.outbox?.observeSend((event) => () => {
      if (live && sending.current === event.id) setReceived(event.id);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [session]);
  const [cleaned, setCleaned] = useState<{
    revision: string | null | undefined;
  }>();
  useEffect(() => {
    if (
      mode === "draft" &&
      cleaned &&
      sent &&
      received === sent &&
      viewRevision(session.scope, entry.id) === cleaned.revision
    )
      onSaved(
        document.activeElement === document.body ||
          !!region.current?.contains(document.activeElement),
      );
  }, [cleaned, sent, received, session, entry.id, onSaved, mode]);
  const sentMessage = (id: string) => {
    sending.current = id;
    setSent(id);
  };
  const draftSaved = () =>
    setCleaned({ revision: viewRevision(session.scope, entry.id) });
  const close = useRef<HTMLButtonElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const waiting =
    loading ||
    !!channel?.cached ||
    !!channel?.pending ||
    (!!channel && !channel.members);
  const writable =
    channel &&
    !channel.cached &&
    !channel.pending &&
    !channel.archived &&
    !channel.readOnly &&
    !!session.viewer &&
    channel.members?.includes(session.viewer);
  useEffect(() => {
    if (!autoFocus || !writable) close.current?.focus();
  }, [autoFocus, writable]);
  async function copy() {
    try {
      const text = mentionDraft(readView(session.scope, entry.id, "")).text;
      if (!text) {
        setCopyStatus("This draft has no text to copy.");
        return;
      }
      await writeClipboardText(text);
      setCopyStatus("Draft text copied.");
    } catch {
      setCopyStatus("Could not copy the text. Try again.");
    }
  }
  return (
    <section
      ref={region}
      className={styles.draftPreview}
      aria-label={`${mode === "draft" ? "Draft for" : "Sent message in"} ${title}`}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.shiftKey ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        event.stopPropagation();
        onClose();
      }}
    >
      <PanelHeader
        title={
          <PanelHeaderLabel
            title={`${title}${entry.threadRootId ? " · Thread reply" : ""}`}
          />
        }
        actions={
          <>
            <IconButton
              size="sm"
              aria-label="Open conversation"
              title="Open conversation"
              icon={<ArrowSquareOutIcon size="1rem" />}
              onClick={onOpen}
              disabled={!channel || channel.cached || channel.pending}
            />
            <IconButton
              ref={close}
              size="sm"
              aria-label={
                mode === "draft" ? "Close draft preview" : "Close sent preview"
              }
              icon={<XIcon size="1rem" />}
              onClick={onClose}
            />
          </>
        }
      />
      <div className={styles.draftBack}>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {mode === "draft" ? "Back to drafts" : "Back to sent"}
        </Button>
      </div>
      {waiting ? (
        <p role="status" className="text-body-sm text-subtle">
          Loading conversation…
        </p>
      ) : writable ? (
        <ConversationChannel
          session={session}
          scope={session.scope}
          channel={channel}
          host={host}
          extensions={extensions}
          threadId={entry.threadRootId}
          active={false}
        >
          {entry.threadRootId ? (
            <ConversationThread
              messageId={mode === "sent" ? entry.id : entry.threadRootId}
              revealSelected={mode === "sent"}
              requireReadyRoot={mode === "draft"}
              autoFocus={autoFocus}
              onDraftSaved={draftSaved}
              onSend={sentMessage}
              active={false}
            />
          ) : (
            <DraftChannel
              title={title}
              target={mode === "sent" ? entry : undefined}
              autoFocus={autoFocus}
              onSaved={draftSaved}
              onSend={sentMessage}
            />
          )}
        </ConversationChannel>
      ) : (
        <div className={styles.draftUnavailable}>
          <p className="text-body-sm text-subtle">
            {mode === "sent"
              ? "This conversation is not available for replying right now."
              : channel
                ? `You can’t post in ${title} anymore. Your draft is still saved.`
                : "This conversation isn’t available right now. Your draft is still saved."}
          </p>
          {mode === "draft" && (
            <Button size="sm" onClick={() => void copy()}>
              Copy text
            </Button>
          )}
          <p role="status" className="text-body-sm text-subtle">
            {copyStatus}
          </p>
        </div>
      )}
    </section>
  );
}

/** Uses the canonical channel reader without changing its saved scroll position. */
function DraftChannel({
  title,
  target,
  autoFocus,
  onSaved,
  onSend,
}: {
  title: string;
  target?: Entry | undefined;
  autoFocus: boolean;
  onSaved(): void;
  onSend(id: string): void;
}) {
  const { session, channelId } = useConversation();
  const window = useChannelWindow(session.channels, channelId);
  const [seekError, setSeekError] = useState(false);
  const [reveal, setReveal] = useState<{
    messageId: string;
    signal: AbortSignal;
  }>();
  useEffect(() => {
    if (!target) return;
    if (window.status !== "ready") return;
    const request = new AbortController();
    setSeekError(false);
    setReveal({ messageId: target.id, signal: request.signal });
    void session.channels
      .seek?.(channelId, target.createdAt ?? 0, request.signal)
      .then(() => {
        if (!request.signal.aborted)
          setSeekError(
            !session.channels
              .window(channelId)
              .rows.some((row) => row.id === target.id),
          );
      })
      .catch(() => {
        if (!request.signal.aborted) setSeekError(true);
      });
    return () => request.abort();
  }, [session, channelId, target, window.status]);
  useEffect(() => {
    if (!target) session.channels.refresh?.(channelId);
  }, [session, channelId, target]);
  useEffect(() => {
    if (window.status === "idle") session.channels.ensure(channelId);
  }, [session, channelId, window.status]);
  return (
    <MessageEditScope>
      <div className={styles.draftConversation}>
        <div className={styles.draftHistory} data-reading-surface="">
          {seekError && (
            <p role="status" className={styles.sectionCopy}>
              The selected message could not be found in this conversation.
            </p>
          )}
          {!!window.rows.length && (
            <ConversationTimeline
              window={window}
              transient
              inlineTarget={reveal}
            />
          )}
          {window.status === "error" || window.error ? (
            <div className={styles.draftUnavailable}>
              <p role="alert" className="text-body-sm">
                {window.error ?? "Could not load conversation."}
              </p>
              <Button
                size="sm"
                onClick={() => session.channels.refresh?.(channelId)}
              >
                Retry conversation
              </Button>
            </div>
          ) : (
            !window.rows.length &&
            (window.status === "ready" ? (
              <EmptyState
                icon={<ChatCircleIcon />}
                title="No messages yet"
                description="Start the conversation below."
              />
            ) : (
              <p
                role="status"
                className={`text-body-sm text-subtle ${styles.sectionCopy}`}
              >
                Loading conversation…
              </p>
            ))
          )}
        </div>
        <ConversationComposer
          label={`Message ${title}`}
          autoFocus={autoFocus}
          onDraftSaved={onSaved}
          onSend={onSend}
        />
      </div>
    </MessageEditScope>
  );
}
