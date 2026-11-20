import { MessageLoading } from "../../features/messages/MessageLoading";
import { useComposerScope } from "../../features/messages/composer-overlay";
import {
  InlineContainers,
  type ThreadHandoff,
} from "../../features/messages/inline-containers";
import {
  memo,
  type ReactNode,
  useContext,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import {
  ConversationTimeline,
  useConversation,
} from "../../features/conversation/Conversation";
import type { ChannelTimelineProps } from "../../features/messages/ChannelTimeline";
import type { PageNavigation } from "../../features/navigation/service";
import { useChannelWindow } from "../../features/relay/react";
import { useRecoveryOwns } from "../../features/relay/RecoveryNotice";
import { headRecovering } from "../../features/relay/live-recovery";
import { clientMetrics } from "../../features/developer/client-metrics";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Channels.module.css";

export const ChannelBody = memo(function ChannelBody({
  cached,
  intro,
  latestRequest,
  viewer,
  revealMessageId,
  openThreadRootId,
  inlineTarget,
  marksRead,
  holding,
  onOpenThread,
  hasThreadTab,
  threadRequest,
  navigation,
  onContentReady,
}: {
  onContentReady?(channelId: string): void;
  cached: boolean;
  intro?: ReactNode;
  latestRequest?: AbortSignal | undefined;
  viewer?: string | undefined;
  navigation?: PageNavigation | undefined;
  revealMessageId?: string | undefined;
  openThreadRootId?: string | undefined;
  /** One exact visit to a loaded message, without a page navigation. */
  inlineTarget?: ChannelTimelineProps["inlineTarget"];
  /** False: viewing rows marks nothing read. */
  marksRead?: boolean | undefined;
  /** Show the loading notice instead of the list, as while a message is sought. */
  holding?: boolean | undefined;
  /** Opens the thread's tab. A thread handed over from its sheet asks it to
   * reveal the reply it was read at, or to reply to its reply target. */
  onOpenThread?:
    | ((
        messageId: string,
        threadRootId: string,
        intent?: "reply" | "reveal",
        replyParent?: string,
      ) => void)
    | undefined;
  /** Whether a thread already has a tab, which it selects instead of reading
   * inline. */
  hasThreadTab?: ((channelId: string, rootId: string) => boolean) | undefined;
  /** A visit to a thread read inline: once the timeline reveals its root, the
   * thread opens over the conversation. */
  threadRequest?: Readonly<{ rootId: string; signal: AbortSignal }> | undefined;
}) {
  // The owner's Solo chat is a chat-style timeline that loads history on scroll.
  const conversation = useConversation();
  const {
    session: queries,
    channelId,
    ownSoloConversation: solo,
  } = conversation;
  const opener = useContext(InlineContainers);
  const composer = useComposerScope();
  // Stable, so memoized message rows keep their props across window updates.
  // The row it opens from is where focus returns: on macOS a click moves none.
  // A thread with a tab, or with nothing to open over, opens its tab.
  const live = useRef({ channelId, composer, onOpenThread, hasThreadTab });
  useLayoutEffect(() => {
    live.current = { channelId, composer, onOpenThread, hasThreadTab };
  });
  const read = useCallback(
    (
      messageId: string,
      rootId: string,
      origin: Element | null,
      intent?: "reply",
    ) => {
      const { channelId, composer, onOpenThread, hasThreadTab } = live.current;
      // A thread handed over from its sheet opens its tab at its reply
      // target's editor, else at the reply it was read at.
      const openAsTab =
        onOpenThread &&
        ((handoff?: ThreadHandoff) => {
          if (handoff?.replyParent)
            onOpenThread(messageId, rootId, "reply", handoff.replyParent);
          else if (handoff?.anchor)
            onOpenThread(handoff.anchor, rootId, "reveal");
          else onOpenThread(messageId, rootId, intent);
        });
      if (!opener) {
        openAsTab?.();
        return;
      }
      opener.open({
        target: {
          kind: "thread",
          channelId,
          rootId,
          messageId,
          reply: intent === "reply",
        },
        composer,
        trigger: origin instanceof HTMLElement ? origin : null,
        hasTab: hasThreadTab?.(channelId, rootId),
        openAsTab,
      });
    },
    [opener],
  );
  const openThread = useCallback(
    (
      messageId: string,
      rootId: string,
      intent?: "reply",
      origin?: Element | null,
    ) => {
      const focused = document.activeElement;
      read(
        messageId,
        rootId,
        origin && !(focused && origin.contains(focused)) ? origin : focused,
        intent,
      );
    },
    [read],
  );
  const request = useRef(threadRequest);
  useLayoutEffect(() => {
    request.current = threadRequest;
  });
  const opened = useRef<AbortSignal | undefined>(undefined);
  // The revealed root holds focus, so it takes focus back when the thread
  // closes.
  const revealed = useCallback(
    (messageId: string, signal: AbortSignal) => {
      const pending = request.current;
      if (
        !pending ||
        pending.signal !== signal ||
        pending.rootId !== messageId ||
        signal.aborted ||
        opened.current === signal
      )
        return;
      opened.current = signal;
      read(messageId, messageId, document.activeElement);
    },
    [read],
  );
  // ChannelWorkspace already keys this lifetime by viewer/scope/generation.
  const continuityKey = useId();
  const window = useChannelWindow(queries.channels, channelId);
  useLayoutEffect(() => {
    clientMetrics.channelMounted(channelId);
    return () => clientMetrics.channelUnmounted(channelId);
  }, [channelId]);
  const headRecovers = useRecoveryOwns(queries, (live) =>
    headRecovering(live, channelId),
  );
  const newest = window.rows.at(-1)?.id;
  const settled = window.status === "ready" || window.status === "error";
  useEffect(() => {
    if (newest || settled) onContentReady?.(channelId);
  }, [channelId, newest, settled, onContentReady]);
  useLayoutEffect(() => {
    // Repeat calls for the same open are ignored; only the first rows count.
    // Any row counts as content, since a saved scroll position may keep the
    // newest one unmounted.
    if (newest)
      clientMetrics.channelRendered(
        channelId,
        () =>
          !!document.querySelector(
            `[data-channel-timeline="${CSS.escape(channelId)}"] [data-message-id]`,
          ),
      );
    else if (settled) clientMetrics.channelEmpty(channelId);
  }, [channelId, newest, settled]);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    // The timeline shows this failure in place, beside its own Retry.
    else if (!cached && window.status === "error")
      navigation?.complete({
        status: "failed",
        reason: "unavailable",
        presented: true,
      });
  }, [cached, navigation, window.status]);
  // While recovery retries this timeline's head read, its notice is the one
  // report, after the quiet delay; the empty timeline waits.
  const timeline =
    window.status === "error" && !window.rows.length && !headRecovers ? (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        role="alert"
      >
        <p>{window.error}</p>
        <Button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </Button>
      </div>
    ) : holding || (window.status !== "ready" && !window.rows.length) ? (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        data-buzz-launch-pending={!cached ? "required" : undefined}
      >
        <MessageLoading />
      </div>
    ) : (
      <ConversationTimeline
        continuityKey={continuityKey}
        intro={intro}
        latestRequest={latestRequest}
        viewer={viewer}
        window={window}
        launchPending={
          !cached &&
          !window.error &&
          (window.status === "idle" ||
            window.status === "loading" ||
            (window.status === "ready" && window.freshness === "cached"))
        }
        {...(onOpenThread ? { onOpenThread: openThread } : {})}
        onRevealed={revealed}
        revealMessageId={revealMessageId}
        openThreadRootId={openThreadRootId}
        inlineTarget={inlineTarget}
        marksRead={marksRead}
        navigation={navigation}
        chatPresentation={solo}
        historyControl={solo ? "scroll" : "button"}
      />
    );
  return timeline;
});
