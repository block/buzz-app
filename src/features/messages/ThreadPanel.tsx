// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The thread region supports keyboard scrolling and Escape.
import { usePanelTabHost } from "../panels/PanelWorkspace";
import { MessageEditScope } from "./MessageEditScope";
import { ReplySummary } from "./ReplySummary";
import { ReplyBranch } from "./ReplyBranch";
import { replyTree } from "./reply-tree";
import { useChannelIdentityNames } from "../identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { XIcon } from "../../shared/design-system/icons/index";
import type {
  ChannelThreadAccessoryProps,
  ConversationExtensions,
} from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { MessageRow } from "./MessageRow";
import { continuesMessageGroup } from "./message-grouping";
import { MessageComposer } from "./MessageComposer";
import { SessionConversationHeader } from "./SessionConversationHeader";
import sessionStyles from "./SessionConversation.module.css";
import styles from "./Messages.module.css";
import { rejectUnhandledFileDrop } from "./use-file-drop";
import { Reading, readingPositioned } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { correctScrollTop } from "./scroll-correction";

export type ThreadPanelProps = {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelName: string;
  channelId: string;
  sessionConversation?: boolean | undefined;
  presentation?: "thread" | "session" | undefined;
  renderThreadAccessory?:
    | ((props: ChannelThreadAccessoryProps) => ReactNode)
    | undefined;
  messageId: string;
  replyRequest?: number | undefined;
  /** Inline Inbox visit retains and reveals its exact selected message. */
  revealSelected?: boolean | undefined;
  headerActions?: ReactNode | undefined;
  /** Saved drafts may compose only against a verified matching root. */
  requireReadyRoot?: boolean | undefined;
  onDraftSaved?: ((id: string) => void) | undefined;
  active?: boolean | undefined;
  navigation?: PageNavigation | undefined;
  /** Omit to embed the thread: no header or Escape dismissal; the owner supplies both. */
  close?: (() => void) | undefined;
  onOpenInThread?: (() => void) | undefined;
  shareInChannel?: ((title: string) => string | undefined) | undefined;
  onOpenLink(url: string): boolean;
  onOpenMediaReview?(
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
    hasComments?: boolean,
  ): void;
  canOpenLink?: ((target: string) => boolean) | undefined;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ThreadPanel(props: ThreadPanelProps) {
  const tabbed = !!usePanelTabHost();
  const { close } = props;
  const viewKey = messageViewKey(
    props.session,
    props.scope,
    props.channelId,
    props.messageId,
  );
  return (
    <aside
      className={`${styles.thread} ${!close ? styles.embeddedThread : ""} ${props.presentation === "session" ? sessionStyles.conversation : ""}`}
      data-attachment-drop-zone=""
      data-reading-surface=""
      onDragOver={rejectUnhandledFileDrop}
      onDrop={rejectUnhandledFileDrop}
      aria-label={props.presentation === "session" ? "Session" : "Thread"}
      onKeyDown={(event) => {
        // Portalled viewers bubble here through React but own their Escape.
        if (
          event.key === "Escape" &&
          !tabbed &&
          close &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {props.presentation !== "session" && !tabbed && close && (
        <ThreadHeader
          key={`header:${viewKey}`}
          close={close}
          actions={props.headerActions}
        />
      )}
      <OwnedThreadPanel key={viewKey} {...props} />
    </aside>
  );
}
function ThreadHeader({
  close,
  actions,
}: {
  close(): void;
  actions?: ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  return (
    <PanelHeader
      title="Thread"
      actions={
        <>
          {actions}
          <IconButton
            ref={closeButton}
            size="toolbar"
            aria-label="Close thread"
            onClick={close}
            icon={<XIcon size={18} aria-hidden="true" />}
          />
        </>
      }
    />
  );
}
function OwnedThreadPanel({
  session,
  extensions,
  scope,
  channelName,
  channelId,
  messageId,
  navigation,
  onOpenLink,
  onOpenMediaReview,
  canOpenLink,
  sessionConversation,
  presentation,
  replyRequest,
  active = true,
  revealSelected,
  requireReadyRoot,
  onDraftSaved,
  shareInChannel,
  onOpenInThread,
  renderThreadAccessory,
  close,
}: ThreadPanelProps) {
  const [title, setTitle] = useState("Session");
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // Allocate in the effect, not render/useMemo: StrictMode must not leak owned views.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery after view allocation fails.
  useEffect(() => {
    try {
      if (navigation?.signal.aborted) return;
      const exact =
        requireReadyRoot ||
        revealSelected ||
        (navigation?.target.kind === "conversation" &&
          navigation.target.threadRootId !== messageId);
      const owned = exact
        ? session.thread(channelId, messageId, { exact: true })
        : session.thread(channelId, messageId);
      const cancel = () => {
        owned.dispose();
        setView(undefined);
      };
      setError(undefined);
      setView(owned);
      navigation?.signal.addEventListener("abort", cancel, { once: true });
      void owned.refresh();
      return () => {
        navigation?.signal.removeEventListener("abort", cancel);
        owned.dispose();
      };
    } catch (error) {
      setError(String(error));
      navigation?.complete({ status: "failed", reason: "unavailable" });
    }
  }, [
    session,
    channelId,
    messageId,
    attempt,
    navigation,
    revealSelected,
    requireReadyRoot,
  ]);
  return (
    <>
      {presentation === "session" && close && (
        <SessionConversationHeader
          title={title}
          back={close}
          onOpenInThread={onOpenInThread}
          share={
            view && !error && shareInChannel
              ? () => {
                  const snapshot = view.snapshot();
                  const root = snapshot.root;
                  if (snapshot.status === "error")
                    return "The session source is unavailable. Retry loading it before sharing.";
                  if (!root || root.id !== messageId)
                    return "The session is still loading. Try again when its first message is available.";
                  return shareInChannel(
                    root.content
                      .slice(0, 4096)
                      .trim()
                      .replace(/\s+/g, " ")
                      .slice(0, 160) || "Session",
                  );
                }
              : undefined
          }
        />
      )}
      {error ? (
        <div className={styles.empty} role="alert">
          <p>{error}</p>
          <Button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {presentation === "session" ? "Retry session" : "Retry thread"}
          </Button>
        </div>
      ) : view ? (
        <ThreadMessages
          sessionConversation={sessionConversation}
          presentation={presentation}
          onTitle={setTitle}
          renderThreadAccessory={renderThreadAccessory}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          view={view}
          navigation={navigation}
          messageId={messageId}
          replyRequest={replyRequest}
          active={active}
          revealSelected={revealSelected}
          requireReadyRoot={requireReadyRoot}
          onDraftSaved={onDraftSaved}
          onOpenLink={onOpenLink}
          onOpenMediaReview={onOpenMediaReview}
          canOpenLink={canOpenLink}
        />
      ) : (
        <p className={styles.empty} role="status">
          {presentation === "session" ? "Loading session…" : "Loading thread…"}
        </p>
      )}
    </>
  );
}
function ThreadMessages({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  messageId,
  view,
  navigation,
  onOpenLink,
  onOpenMediaReview,
  canOpenLink,
  sessionConversation,
  presentation,
  onTitle,
  replyRequest,
  active,
  revealSelected,
  requireReadyRoot,
  onDraftSaved,
  renderThreadAccessory,
}: {
  sessionConversation?: boolean | undefined;
  presentation?: ThreadPanelProps["presentation"];
  renderThreadAccessory?: ThreadPanelProps["renderThreadAccessory"];
  onTitle(title: string): void;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  view: ThreadView;
  replyRequest?: number | undefined;
  active?: boolean | undefined;
  revealSelected?: boolean | undefined;
  requireReadyRoot?: boolean | undefined;
  onDraftSaved?: ThreadPanelProps["onDraftSaved"];
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string): boolean;
  onOpenMediaReview?: ThreadPanelProps["onOpenMediaReview"];
  canOpenLink?: ((target: string) => boolean) | undefined;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  // Read the current root only when sharing; paging must not invalidate every reply row.
  const getThreadRoot = useCallback(() => {
    const current = view.snapshot();
    return current.status === "ready" ? current.root : undefined;
  }, [view]);
  useEffect(() => {
    if (presentation !== "session") return;
    // Plain text only, bounded independently of profiles and title enrichment.
    const excerpt = snapshot.root?.content
      .slice(0, 4096)
      .trim()
      .replace(/\s+/g, " ");
    onTitle(excerpt ? excerpt.slice(0, 160) : "Session");
  }, [presentation, snapshot.root?.content, onTitle]);
  const tree = useMemo(
    () => replyTree(snapshot.replies, snapshot.root?.id),
    [snapshot.replies, snapshot.root?.id],
  );
  const branchReplies = useMemo(() => {
    const branches = new Map<string, ChannelMessage[]>();
    for (const reply of snapshot.replies) {
      for (const ancestor of tree.ancestors(reply.id)) {
        const replies = branches.get(ancestor) ?? [];
        replies.push(reply);
        branches.set(ancestor, replies);
      }
    }
    return branches;
  }, [tree, snapshot.replies]);
  const subscribeUnread = useCallback(
    (listener: () => void) =>
      session.unread.subscribe(
        { kind: "thread", channelId, rootId: snapshot.root?.id ?? messageId },
        listener,
      ),
    [session.unread, channelId, snapshot.root?.id, messageId],
  );
  const unreadSnapshot = useCallback(
    () =>
      session.unread.snapshot({
        kind: "thread",
        channelId,
        rootId: snapshot.root?.id ?? messageId,
      }),
    [session.unread, channelId, snapshot.root?.id, messageId],
  );
  useSyncExternalStore(subscribeUnread, unreadSnapshot, unreadSnapshot);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [replyParent, setReplyParent] = useState<string>();
  const resolveName = useChannelIdentityNames(session, channelId);
  const rows = useMemo(
    () =>
      snapshot.root ? [snapshot.root, ...snapshot.replies] : snapshot.replies,
    [snapshot.root, snapshot.replies],
  );
  const authors = [
    ...new Set(
      rows.flatMap((row) => [
        row.authorId,
        ...row.mentions,
        ...(row.mentionReferences ?? []),
      ]),
    ),
  ]
    .sort()
    .join(":");
  useEffect(() => {
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors]);
  const profiles = useRowProfiles(session.profiles, rows);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const scroller = useRef<HTMLElement>(null);
  const accessoryElement = useRef<HTMLDivElement>(null);
  const accessoryHeight = useRef(0);
  const positioned = useRef(false);
  const readingSettled = useRef(false);
  const [initialPositioned, setInitialPositioned] = useState(false);
  const follow = useRef(true);
  const jumpingToLatest = useRef(false);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const previousReplies = useRef({
    ids: new Set(snapshot.replies.map((reply) => reply.id)),
    latestCreatedAt: Math.max(
      0,
      ...snapshot.replies.map((reply) => reply.createdAt),
    ),
    complete: snapshot.status === "ready" && !snapshot.canLoadMore,
  });
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  useEffect(
    () => () => {
      if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
    },
    [],
  );
  const olderAnchor = useRef<
    { id: string; top: number; ancestors: readonly string[] } | undefined
  >(undefined);
  const olderDemand = useRef(false);
  const targetAnchor = useRef<number | undefined>(undefined);
  const selectedRow = useCallback(
    () =>
      [
        ...(scroller.current?.querySelectorAll<HTMLElement>(
          "[data-message-id]",
        ) ?? []),
      ].find((row) => row.dataset.messageId === messageId),
    [messageId],
  );
  // A late ancestor reparents the exact row. Transfer only focus owned at detach,
  // within this commit/layout expansion; a later user expansion must not restore it.
  const selectedBranchRef = useMemo(() => {
    let restore = false;
    return (branch: HTMLLIElement | null) => {
      if (!branch) return;
      const row = branch.querySelector<HTMLElement>("[data-message-id]");
      if (
        restore &&
        row &&
        !navigation?.signal.aborted &&
        !branch.closest("[inert]") &&
        document.activeElement === document.body
      ) {
        row.tabIndex = -1;
        row.focus({ preventScroll: true });
      }
      restore = false;
      return () => {
        restore =
          row?.dataset.messageId === messageId &&
          document.activeElement === row;
        // Ancestor expansion happens synchronously in a layout effect. Do not
        // retain focus intent after this update (deletion or unmount).
        queueMicrotask(() => {
          restore = false;
        });
      };
    };
  }, [messageId, navigation?.signal]);
  const selectedOffset = useCallback(() => {
    const row = selectedRow();
    const container = scroller.current;
    return row && container
      ? row.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop
      : undefined;
  }, [selectedRow]);
  const completeTarget = useCallback(() => {
    // Exact lookup can finish before context. Preserve this row's reading
    // position through prepended history without refocusing it after opening.
    targetAnchor.current = selectedOffset();
    readingSettled.current = true;
    readingPositioned(scroller.current);
    navigation?.complete({ status: "opened" });
  }, [navigation, selectedOffset]);
  const prepareTarget = useCallback(() => {
    follow.current = false;
  }, []);
  const revealedAncestors = useRef(new Set<string>());
  // A continuation may supply the parent of the visible reply. Commit its new
  // ancestors before restoring geometry; expanded branches stay open.
  useLayoutEffect(() => {
    const anchor = olderAnchor.current;
    if (!anchor || snapshot.status === "loading") return;
    const added = tree
      .ancestors(anchor.id)
      .filter((id) => !anchor.ancestors.includes(id));
    if (added.length)
      setExpanded((current) => {
        if (added.every((id) => current.has(id))) return current;
        return new Set([...current, ...added]);
      });
  }, [tree, snapshot.status]);
  // Exact targets may precede their ancestors in bounded history. Reveal every
  // available ancestor as it arrives; missing parents remain visible at the top.
  useLayoutEffect(() => {
    if (navigation?.signal.aborted) return;
    const ancestors = tree
      .ancestors(messageId)
      .filter((id) => !revealedAncestors.current.has(id));
    for (const id of ancestors) revealedAncestors.current.add(id);
    if (ancestors.length)
      setExpanded((current) => {
        if (ancestors.every((id) => current.has(id))) return current;
        return new Set([...current, ...ancestors]);
      });
  }, [tree, messageId, navigation]);
  const rootTarget =
    navigation?.target.kind === "conversation" &&
    navigation.target.threadRootId === messageId;
  // Ordinary opens follow the latest reply after bounded history finishes.
  // Keep that first positioning invisible; exact-message navigation reveals itself.
  const positioning =
    !revealSelected &&
    !initialPositioned &&
    (!navigation || rootTarget) &&
    snapshot.status !== "error";
  const [inlineReveal, setInlineReveal] = useState<AbortSignal>();
  useEffect(() => {
    if (!revealSelected) return;
    const request = new AbortController();
    setInlineReveal(request.signal);
    return () => request.abort();
  }, [revealSelected]);
  const revealSignal =
    inlineReveal ?? (rootTarget ? undefined : navigation?.signal);
  const revealed = useMessageReveal({
    scroller,
    settled: positioned,
    messageId,
    signal: active ? revealSignal : undefined,
    ready:
      snapshot.targetStatus === "ready" && snapshot.target?.id === messageId,
    complete: completeTarget,
    prepare: prepareTarget,
  });
  useEffect(() => {
    if (!navigation || navigation.signal.aborted) return;
    if (rootTarget && snapshot.status === "error")
      navigation.complete({ status: "failed", reason: "unavailable" });
    else if (snapshot.targetStatus === "unavailable")
      navigation.complete({ status: "failed", reason: "not-found" });
    else if (snapshot.targetStatus === "error")
      navigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, rootTarget, snapshot.status, snapshot.targetStatus]);
  const [sent, setSent] = useState<string>();
  const [replyFocus, setReplyFocus] = useState(0);
  const focusReply = useCallback(() => {
    setReplyParent(undefined);
    setReplyFocus((value) => value + 1);
  }, []);
  const targetReply = useCallback((id: string) => {
    setReplyParent((current) => (current === id ? undefined : id));
    setReplyFocus((value) => value + 1);
  }, []);
  useEffect(() => {
    if (replyRequest) focusReply();
  }, [replyRequest, focusReply]);
  const [mediaSeek, setMediaSeek] = useState<{
    seconds: number;
    request: number;
  }>();
  const rootId = snapshot.root?.id;
  const hasMediaComments =
    (snapshot.root?.replyCount ?? 0) > 0 ||
    snapshot.replies.length > 0 ||
    (!!snapshot.target && snapshot.target.id !== rootId);
  const openRootMedia = useCallback(
    (
      _rowId: string,
      attachment: ChannelMessage["attachments"][number],
      seconds: number,
    ) => {
      if (rootId)
        onOpenMediaReview?.(_rowId, attachment, seconds, hasMediaComments);
    },
    [rootId, onOpenMediaReview, hasMediaComments],
  );
  // Without a selected viewer, bare timecodes need one unambiguous video.
  const videoUrls = new Set(
    [snapshot.root, snapshot.target, ...snapshot.replies].flatMap(
      (row) =>
        row?.attachments
          .filter((item) => item.kind === "video")
          .map((item) => item.url) ?? [],
    ),
  );
  const videoOwner =
    videoUrls.size === 1
      ? [snapshot.root, snapshot.target, ...snapshot.replies].find((row) =>
          row?.attachments.some((item) => item.kind === "video"),
        )
      : undefined;
  const videoAttachment = videoOwner?.attachments.find(
    (item) => item.kind === "video",
  );
  const canSeekVideo =
    !!videoAttachment && (videoOwner?.id === rootId || !!onOpenMediaReview);
  const handleMediaTime = useCallback(
    (seconds: number) => {
      if (!videoOwner || !videoAttachment) return;
      if (videoOwner.id !== rootId) {
        // A reply's video may be inside a collapsed branch. Open its canonical
        // viewer instead of seeking an absent preview or an unrelated root.
        openRootMedia(videoOwner.id, videoAttachment, seconds);
        return;
      }
      setMediaSeek((current) => ({
        seconds,
        request: (current?.request ?? 0) + 1,
      }));
    },
    [videoOwner, videoAttachment, rootId, openRootMedia],
  );
  // Only legacy traversal is eager. Strict windows open at the newest page.
  useEffect(() => {
    if (
      snapshot.direction !== "older" &&
      snapshot.status === "ready" &&
      snapshot.canLoadMore
    )
      void view.loadMore();
  }, [view, snapshot]);
  useLayoutEffect(() => {
    const previous = previousReplies.current;
    const complete = snapshot.status === "ready" && !snapshot.canLoadMore;
    // Initial traversal has no baseline. Once complete, retain the last
    // observed replies through reconnect loading so recovery can reconcile them.
    if (!complete && !previous.complete) return;
    const arrivals =
      complete && previous.complete
        ? snapshot.replies.filter(
            (reply) =>
              !previous.ids.has(reply.id) &&
              reply.createdAt >= previous.latestCreatedAt,
          ).length
        : 0;
    if (complete)
      previousReplies.current = {
        ids: new Set(snapshot.replies.map((reply) => reply.id)),
        latestCreatedAt: Math.max(
          previous.latestCreatedAt,
          ...snapshot.replies.map((reply) => reply.createdAt),
        ),
        complete: true,
      };
    if (arrivals > 0 && !follow.current)
      setNewMessageCount((count) => count + arrivals);
  }, [snapshot.status, snapshot.canLoadMore, snapshot.replies]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rendered rows/profiles change scroll height; sending is explicit navigation intent.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || navigation?.signal.aborted) return;
    // Restored background tabs verify their target without competing for focus.
    if (
      navigation &&
      !active &&
      snapshot.targetStatus === "ready" &&
      snapshot.target?.id === messageId &&
      revealed.current !== navigation.signal
    ) {
      revealed.current = navigation.signal;
      navigation.complete({ status: "opened" });
    }
    // A mounted ordinary thread acknowledges the visit before slow history can
    // exhaust navigation's deadline. Positioning still waits for bounded loading.
    if (
      rootTarget &&
      snapshot.status !== "error" &&
      snapshot.root?.id === messageId &&
      revealed.current !== navigation.signal
    ) {
      revealed.current = navigation.signal;
      navigation.complete({ status: "opened" });
    }
    if (
      (revealSelected && !inlineReveal) ||
      (revealSignal && revealed.current !== revealSignal) ||
      (!positioned.current &&
        ((snapshot.status !== "ready" &&
          !(
            snapshot.status === "loading" &&
            snapshot.readKind === "refresh" &&
            snapshot.root
          )) ||
          (snapshot.direction !== "older" && snapshot.canLoadMore)))
    )
      return;
    if (olderAnchor.current) {
      const anchor = olderAnchor.current;
      const added = tree
        .ancestors(anchor.id)
        .filter((id) => !anchor.ancestors.includes(id));
      if (added.every((id) => expanded.has(id))) {
        const row = [
          ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
        ].find((row) => row.dataset.messageId === anchor.id);
        if (row)
          correctScrollTop(
            element,
            row.getBoundingClientRect().top - anchor.top,
          );
        if (snapshot.status !== "loading") olderAnchor.current = undefined;
      }
    }
    if (targetAnchor.current !== undefined) {
      const offset = selectedOffset();
      if (offset !== undefined) {
        correctScrollTop(element, offset - targetAnchor.current);
        targetAnchor.current = offset;
        follow.current = false;
      }
      if (snapshot.status !== "loading" && !snapshot.canLoadMore)
        targetAnchor.current = undefined;
    }
    // Initial positioning waits for one strict page or the legacy bounded walk.
    // subsequent live changes follow only while the reader is at the bottom.
    if (follow.current) element.scrollTop = element.scrollHeight;
    positioned.current = true;
    setInitialPositioned(true);
    readingPositioned(element);
    if (jumpingToLatest.current) {
      setShowJumpToLatest(false);
    } else {
      const bottom =
        element.scrollHeight - element.clientHeight - element.scrollTop < 80;
      setShowJumpToLatest(!bottom);
      if (bottom) setNewMessageCount(0);
    }
  }, [
    active,
    revealSelected,
    inlineReveal,
    revealSignal,
    snapshot.status,
    snapshot.targetStatus,
    snapshot.target,
    snapshot.canLoadMore,
    snapshot.direction,
    snapshot.root,
    messageId,
    rows,
    profiles,
    sent,
    navigation,
    rootTarget,
    revealed,
    selectedOffset,
    tree,
    expanded,
  ]);
  // Main's retained presentation can be usable before the initial history walk
  // finishes. That is not yet automatic reading intent. Exact revealed targets
  // remain individually readable; later background refreshes keep earned readiness.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active can complete an exact background visit in the preceding layout effect without changing the snapshot.
  useLayoutEffect(() => {
    if (
      !positioned.current ||
      readingSettled.current ||
      (navigation && !rootTarget && revealed.current !== navigation.signal)
    )
      return;
    if (
      snapshot.status === "ready" &&
      (snapshot.direction === "older" || !snapshot.canLoadMore)
    ) {
      readingSettled.current = true;
      readingPositioned(scroller.current);
    }
  }, [active, navigation, rootTarget, revealed, snapshot]);
  // An own send can land in the middle of a branch, not at the list bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry DOM lookup after history or branch visibility changes.
  useLayoutEffect(() => {
    if (!sent) return;
    const row = [
      ...(scroller.current?.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      ) ?? []),
    ].find((element) => element.dataset.messageId === sent);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      setSent(undefined);
    }
  }, [sent, snapshot.replies, expanded]);
  const jumpToLatest = () => {
    const element = scroller.current;
    if (!element) return;
    targetAnchor.current = undefined;
    positioned.current = true;
    follow.current = true;
    jumpingToLatest.current = true;
    element.focus({ preventScroll: true });
    setShowJumpToLatest(false);
    setNewMessageCount(0);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => {
      jumpTimer.current = undefined;
      const current = scroller.current;
      if (!current || !jumpingToLatest.current) return;
      current.scrollTop = current.scrollHeight;
      jumpingToLatest.current = false;
    }, 1000);
  };

  // The history owner, not the plugin, preserves native message reading position.
  // Only the accessory is observed: no second message reader or global scroll owner.
  const accessoryAnchor = useRef<
    { element: HTMLElement; top: number } | undefined
  >(undefined);
  const rememberAccessoryAnchor = useCallback(() => {
    const element = scroller.current;
    if (!element || !accessoryElement.current) return;
    const top = element.getBoundingClientRect().top;
    const row = [
      ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((row) => row.getBoundingClientRect().bottom > top);
    accessoryAnchor.current = row
      ? { element: row, top: row.getBoundingClientRect().top }
      : undefined;
  }, []);
  const hasAccessory =
    presentation === "session" &&
    snapshot.root?.id === messageId &&
    snapshot.root.channelId === channelId &&
    snapshot.root.threadRootId === undefined &&
    snapshot.status !== "error" &&
    !!renderThreadAccessory;
  useLayoutEffect(() => {
    const element = scroller.current,
      accessory = accessoryElement.current;
    if (!hasAccessory || !element || !accessory) return;
    rememberAccessoryAnchor();
    accessoryHeight.current = accessory.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const next = accessory.getBoundingClientRect().height;
      if (next === accessoryHeight.current) return;
      accessoryHeight.current = next;
      if (positioned.current) {
        const anchor = accessoryAnchor.current;
        if (follow.current) element.scrollTop = element.scrollHeight;
        else if (anchor?.element.isConnected)
          element.scrollTop +=
            anchor.element.getBoundingClientRect().top - anchor.top;
      }
      rememberAccessoryAnchor();
    });
    observer.observe(accessory);
    return () => observer.disconnect();
  }, [hasAccessory, rememberAccessoryAnchor]);
  const keepReadingPosition = () => {
    jumpingToLatest.current = false;
    if (jumpTimer.current !== undefined) {
      clearTimeout(jumpTimer.current);
      jumpTimer.current = undefined;
    }
    olderDemand.current = true;
    targetAnchor.current = undefined;
    setInitialPositioned(true);
    if (positioned.current) return;
    positioned.current = true;
    follow.current = false;
  };
  let previousReply: ChannelMessage | undefined = snapshot.root;
  let previousParent: string | undefined;
  function renderReplies(parent: string | undefined, depth = 0): ReactNode {
    return (tree.children.get(parent) ?? []).map((row) => {
      const children = tree.children.get(row.id);
      const continuation =
        previousParent === parent && continuesMessageGroup(previousReply, row);
      const day =
        !previousReply ||
        new Date(previousReply.createdAt * 1000).toDateString() !==
          new Date(row.createdAt * 1000).toDateString();
      previousReply =
        children?.length && !expanded.has(row.id) ? undefined : row;
      previousParent = parent;
      const descendants = branchReplies.get(row.id) ?? [];
      const unreadCount = descendants.filter(
        (reply) => session.unread.attention(channelId, reply.id).unread,
      ).length;
      const unreadLabel = unreadCount
        ? `${unreadCount} new in available replies`
        : undefined;
      const message = (
        <MessageRow
          extensions={extensions}
          session={session}
          scope={scope}
          onReply={snapshot.root ? targetReply : undefined}
          row={row}
          getThreadRoot={getThreadRoot}
          profile={profiles.get(row.authorId)}
          participantProfiles={profiles}
          agentPubkeys={agentPubkeys}
          media={session.media}
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
          day={day}
          layout={continuation ? "continuation" : "thread"}
          compactAvatar={depth > 0}
          retry={session.messages.retry}
          {...(canSeekVideo ? { onMediaTime: handleMediaTime } : {})}
          {...(onOpenMediaReview && rootId
            ? { onOpenMediaReview: openRootMedia }
            : {})}
        />
      );
      return (
        <li
          key={row.id}
          ref={row.id === messageId ? selectedBranchRef : undefined}
          className={styles.replyItem}
          data-layout={continuation ? "continuation" : "thread"}
        >
          {!parent && row.replyParentId && row.replyParentId !== rootId && (
            <p className={styles.threadNote}>
              Earlier reply unavailable in loaded history.
            </p>
          )}

          <ReplyBranch
            message={message}
            hasReplies={!!children?.length}
            layout={continuation ? "continuation" : "thread"}
            label={`View ${descendants.length} ${descendants.length === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}`}
            summary={
              <ReplySummary
                count={descendants.length}
                participants={[
                  ...new Set(descendants.map((reply) => reply.authorId)),
                ]}
                profiles={profiles}
                agentPubkeys={agentPubkeys}
                resolveName={resolveName}
                media={session.media}
                unreadLabel={unreadLabel}
                unreadCount={unreadCount}
              />
            }
            depth={depth}
            open={expanded.has(row.id)}
            onExpand={() => {
              follow.current = false;
              targetAnchor.current = undefined;
              setExpanded((current) => new Set([...current, row.id]));
            }}
          >
            {expanded.has(row.id) && (
              <ol>{renderReplies(row.id, depth + 1)}</ol>
            )}
          </ReplyBranch>
        </li>
      );
    });
  }
  const selectedParent = snapshot.replies.find((row) => row.id === replyParent);
  const captureOlderAnchor = (element: HTMLElement) => {
    follow.current = false;
    const row = [
      ...element.querySelectorAll<HTMLElement>("ol [data-message-id]"),
    ].find(
      (row) =>
        row.getBoundingClientRect().bottom >
        element.getBoundingClientRect().top,
    );
    olderAnchor.current = row?.dataset.messageId
      ? {
          id: row.dataset.messageId,
          top: row.getBoundingClientRect().top,
          ancestors: tree.ancestors(row.dataset.messageId),
        }
      : undefined;
  };
  const loadOlder = () => {
    const element = scroller.current;
    if (
      !element ||
      !olderDemand.current ||
      snapshot.direction !== "older" ||
      snapshot.status !== "ready" ||
      !snapshot.canLoadMore ||
      element.scrollTop >
        Math.max(80, (element.scrollHeight - element.clientHeight) * 0.2)
    )
      return;
    olderDemand.current = false;
    captureOlderAnchor(element);
    void view.loadMore();
  };
  const showOlderPageStatus =
    snapshot.direction === "older" &&
    snapshot.readKind === "older" &&
    !!snapshot.root;
  const retryThread = () => {
    if (showOlderPageStatus) {
      if (scroller.current) captureOlderAnchor(scroller.current);
      void view.loadMore();
    } else void view.refresh();
  };
  return (
    <MessageEditScope>
      <Reading
        session={session}
        channelId={channelId}
        scroller={scroller}
        settled={readingSettled}
        rootId={snapshot.root?.id}
        // A visible exact reply can outlive its unavailable root. Until resolved,
        // observe rows individually; an absent root must not mean channel catch-up.
        latestMessageId={
          snapshot.root
            ? snapshot.replies.reduce<ChannelMessage | undefined>(
                (latest, row) =>
                  !latest || row.createdAt > latest.createdAt ? row : latest,
                undefined,
              )?.id
            : undefined
        }
      />
      <section
        ref={scroller}
        data-message-scroller
        className={styles.threadHistory}
        aria-label={
          presentation === "session" ? "Session messages" : "Thread messages"
        }
        aria-busy={positioning}
        data-positioning={positioning || undefined}
        style={hasAccessory ? { overflowAnchor: "none" } : undefined}
        onScroll={(event) => {
          if (!positioned.current) return;
          // Shrinking content can clamp native scrollTop before ResizeObserver
          // runs. Preserve pre-resize intent/anchor until that owner compensates.
          const accessory = accessoryElement.current;
          if (
            accessory &&
            accessory.getBoundingClientRect().height !== accessoryHeight.current
          )
            return;
          const element = event.currentTarget;
          if (olderAnchor.current) {
            const anchor = olderAnchor.current;
            const row = [
              ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
            ].find((row) => row.dataset.messageId === anchor.id);
            if (row) anchor.top = row.getBoundingClientRect().top;
          }
          const bottom =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            80;
          if (jumpingToLatest.current) return;
          follow.current = bottom;
          setShowJumpToLatest(!bottom);
          if (bottom) setNewMessageCount(0);
          rememberAccessoryAnchor();
          loadOlder();
        }}
        onWheel={(event) => {
          keepReadingPosition();
          if (event.deltaY < 0) loadOlder();
        }}
        onTouchMove={() => {
          keepReadingPosition();
          loadOlder();
        }}
        onPointerDown={keepReadingPosition}
        onKeyDown={(event) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key)
          ) {
            keepReadingPosition();
            if (
              ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
              (event.key === " " && event.shiftKey)
            )
              loadOlder();
          }
        }}
        tabIndex={0}
      >
        <JumpToLatestButton
          visible={showJumpToLatest}
          newMessageCount={newMessageCount}
          onClick={jumpToLatest}
        />
        <div data-thread-rows="" inert={positioning}>
          {snapshot.root ? (
            <MessageRow
              extensions={extensions}
              session={session}
              scope={scope}
              onReply={focusReply}
              row={snapshot.root}
              profile={profiles.get(snapshot.root.authorId)}
              participantProfiles={profiles}
              agentPubkeys={agentPubkeys}
              media={session.media}
              onOpenLink={onOpenLink}
              canOpenLink={canOpenLink}
              day={true}
              layout="thread"
              retry={session.messages.retry}
              mediaMode="thread"
              {...(mediaSeek
                ? {
                    mediaSeekTo: mediaSeek.seconds,
                    mediaSeekRequest: mediaSeek.request,
                  }
                : {})}
              {...(onOpenMediaReview
                ? { onOpenMediaReview: openRootMedia }
                : {})}
            />
          ) : snapshot.status !== "loading" ? (
            <p className={styles.empty}>Original message unavailable.</p>
          ) : null}
          {hasAccessory && snapshot.root && renderThreadAccessory && (
            <div ref={accessoryElement}>
              {renderThreadAccessory({
                session,
                scope,
                channelId,
                threadRootId: snapshot.root.id,
                messages: rows,
              })}
            </div>
          )}
          {presentation !== "session" && (
            <div className={styles.threadDivider}>
              {snapshot.replies.length}{" "}
              {snapshot.replies.length === 1 ? "reply shown" : "replies shown"}
            </div>
          )}
          <ol>
            {showOlderPageStatus && snapshot.error && (
              <li className={styles.threadHistoryPageStatus}>
                <p role="alert">{snapshot.error}</p>
                <Button type="button" onClick={retryThread}>
                  Retry thread
                </Button>
              </li>
            )}
            {renderReplies(undefined)}
          </ol>
        </div>
        {requireReadyRoot &&
          snapshot.root &&
          snapshot.root.id !== messageId && (
            <p role="status">
              This saved draft does not identify a thread root. Open its origin
              to check the destination.
            </p>
          )}
        {positioning ||
        (snapshot.status === "loading" &&
          (!rows.length || presentation === "session")) ? (
          <p role="status">
            {presentation === "session"
              ? "Loading session…"
              : "Loading thread…"}
          </p>
        ) : null}
        {snapshot.targetStatus === "unavailable" && (
          <p role="status">Selected message unavailable.</p>
        )}
        {snapshot.error && !showOlderPageStatus && (
          <p role="alert">{snapshot.error}</p>
        )}
        {snapshot.limited && !snapshot.error && (
          <p className={styles.threadNote}>
            {presentation === "session"
              ? "Session history limit reached."
              : "Thread history limit reached."}
          </p>
        )}
        {((snapshot.error && !showOlderPageStatus) ||
          snapshot.targetStatus === "unavailable") && (
          <div className={styles.threadHistoryControls}>
            <Button type="button" onClick={() => void view.refresh()}>
              {presentation === "session" ? "Retry session" : "Retry thread"}
            </Button>
          </div>
        )}
      </section>
      {snapshot.root &&
        (!requireReadyRoot ||
          (snapshot.root.id === messageId &&
            snapshot.targetStatus === "ready")) && (
          <MessageComposer
            sessionConversation={sessionConversation}
            label={
              presentation === "session" ? "Message this session" : undefined
            }
            key={`${scope}:${channelId}:${snapshot.root.id}`}
            extensions={extensions}
            session={session}
            scope={scope}
            channelId={channelId}
            channelName={channelName}
            placeholder={`Reply in thread to ${resolveName(snapshot.root.authorId, profiles.get(snapshot.root.authorId)?.name ?? formatPublicKey(snapshot.root.authorId) ?? "Unknown author")}`}
            threadRootId={snapshot.root.id}
            replyParentId={replyParent}
            disabled={
              (requireReadyRoot &&
                (snapshot.status !== "ready" || !!snapshot.error)) ||
              (!!replyParent && !selectedParent)
            }
            replyContext={
              replyParent && !selectedParent ? (
                <div className={styles.replyContext}>
                  <span>Reply target is no longer available.</span>
                  <Button size="sm" onClick={focusReply}>
                    Cancel reply target
                  </Button>
                </div>
              ) : (
                selectedParent && (
                  <div className={styles.replyContext}>
                    <div>
                      <span>
                        Replying to{" "}
                        {resolveName(
                          selectedParent.authorId,
                          profiles.get(selectedParent.authorId)?.name ??
                            formatPublicKey(selectedParent.authorId) ??
                            "Unknown author",
                        )}
                      </span>
                      <p>{selectedParent.content}</p>
                    </div>
                    <IconButton
                      size="sm"
                      aria-label="Cancel reply target"
                      onClick={focusReply}
                      icon={<XIcon size={16} aria-hidden="true" />}
                    />
                  </div>
                )
              )
            }
            editMessages={rows}
            focusRequest={replyFocus}
            onOpenLink={onOpenLink}
            canOpenLink={canOpenLink}
            onDraftSaved={onDraftSaved}
            onSend={(id) => {
              targetAnchor.current = undefined;
              positioned.current = true;
              follow.current = !selectedParent;
              if (selectedParent)
                setExpanded(
                  (current) =>
                    new Set([
                      ...current,
                      selectedParent.id,
                      ...tree.ancestors(selectedParent.id),
                    ]),
                );
              setReplyParent(undefined);
              setSent(id);
            }}
          />
        )}
    </MessageEditScope>
  );
}
