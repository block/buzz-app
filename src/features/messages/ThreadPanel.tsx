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
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { XIcon } from "../../shared/design-system/icons/index";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { MessageRow } from "./MessageRow";
import { continuesMessageGroup } from "./message-grouping";
import { MessageComposer } from "./MessageComposer";
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
  messageId: string;
  replyRequest?: number | undefined;
  active?: boolean | undefined;
  navigation?: PageNavigation | undefined;
  /** Omit to embed the thread: no header or Escape dismissal; the owner supplies both. */
  close?: (() => void) | undefined;
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
      className={
        close ? styles.thread : `${styles.thread} ${styles.embeddedThread}`
      }
      data-attachment-drop-zone=""
      data-reading-surface=""
      onDragOver={rejectUnhandledFileDrop}
      onDrop={rejectUnhandledFileDrop}
      aria-label="Thread"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !tabbed && close) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {!tabbed && close && (
        <ThreadHeader key={`header:${viewKey}`} close={close} />
      )}
      <OwnedThreadPanel key={viewKey} {...props} />
    </aside>
  );
}
function ThreadHeader({ close }: { close(): void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  return (
    <PanelHeader
      title="Thread"
      actions={
        <IconButton
          ref={closeButton}
          size="toolbar"
          aria-label="Close thread"
          onClick={close}
          icon={<XIcon size={18} aria-hidden="true" />}
        />
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
  replyRequest,
  active = true,
}: ThreadPanelProps) {
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // Allocate in the effect, not render/useMemo: StrictMode must not leak owned views.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery after view allocation fails.
  useEffect(() => {
    try {
      if (navigation?.signal.aborted) return;
      const exact =
        navigation?.target.kind === "conversation" &&
        navigation.target.threadRootId !== messageId;
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
  }, [session, channelId, messageId, attempt, navigation]);
  return error ? (
    <div className={styles.empty} role="alert">
      <p>{error}</p>
      <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
        Retry thread
      </Button>
    </div>
  ) : view ? (
    <ThreadMessages
      sessionConversation={sessionConversation}
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
      onOpenLink={onOpenLink}
      onOpenMediaReview={onOpenMediaReview}
      canOpenLink={canOpenLink}
    />
  ) : (
    <p className={styles.empty} role="status">
      Loading thread…
    </p>
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
  replyRequest,
  active,
}: {
  sessionConversation?: boolean | undefined;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  view: ThreadView;
  replyRequest?: number | undefined;
  active?: boolean | undefined;
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
  const virtualizer = useRef<VirtualizerHandle>(null);
  const intro = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, introHeight: 0 });
  const [focusedId, setFocusedId] = useState<string>();
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(new Set());
  const keepRowMounted = useCallback((id: string) => {
    setPinnedIds((ids) => new Set(ids).add(id));
    return () =>
      setPinnedIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
  }, []);
  const branches = tree.children.get(undefined) ?? [];
  const previousBranches = useRef(branches);
  const prepend =
    branches.length > previousBranches.current.length &&
    previousBranches.current.length > 0 &&
    previousBranches.current.every(
      (row, index) =>
        branches[branches.length - previousBranches.current.length + index]
          ?.id === row.id,
    );
  useLayoutEffect(() => {
    previousBranches.current = branches;
  }, [branches]);
  const branchIndex = (id: string | undefined) => {
    if (!id) return -1;
    if (id === snapshot.root?.id) return -1;
    const ancestors = tree.ancestors(id);
    const index = branches.findIndex(
      (row) => row.id === id || ancestors.includes(row.id),
    );
    return index;
  };
  const intent = useRef(0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        introHeight: intro.current?.getBoundingClientRect().height ?? 0,
      };
      setSize((current) =>
        current.width === next.width &&
        current.height === next.height &&
        current.introHeight === next.introHeight
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (intro.current) observer.observe(intro.current);
    return () => observer.disconnect();
  }, []);
  const positioned = useRef(false);
  const positioningStarted = useRef<number | undefined>(undefined);
  const readingSettled = useRef(false);
  const [initialPositioned, setInitialPositioned] = useState(false);
  const follow = useRef(true);
  const measuredPosition = useRef({ offset: 0, height: 0 });
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
    return (branch: HTMLElement | null) => {
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
      ? row.getBoundingClientRect().top - container.getBoundingClientRect().top
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
    intent.current++;
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
    !initialPositioned &&
    (!navigation || rootTarget) &&
    snapshot.status !== "error";
  const revealed = useMessageReveal({
    scroller,
    settled: positioned,
    messageId,
    signal: rootTarget || !active ? undefined : navigation?.signal,
    ready:
      !!size.width &&
      !!size.height &&
      snapshot.targetStatus === "ready" &&
      snapshot.target?.id === messageId,
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
      (navigation && !rootTarget && revealed.current !== navigation.signal) ||
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
    if (!size.width || !size.height) return;
    // Virtua owns measuring and retaining the requested destination. Thread
    // code supplies reading intent, not a second scroll-height correction.
    const scheduledIntent = intent.current;
    if (!positioned.current) positioningStarted.current ??= performance.now();
    if (olderAnchor.current) {
      const anchor = olderAnchor.current;
      const added = tree
        .ancestors(anchor.id)
        .filter((id) => !anchor.ancestors.includes(id));
      if (!prepend && added.length && added.every((id) => expanded.has(id))) {
        const row = [
          ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
        ].find((row) => row.dataset.messageId === anchor.id);
        if (row)
          correctScrollTop(
            element,
            row.getBoundingClientRect().top - anchor.top,
          );
      }
      if (
        snapshot.status !== "loading" &&
        added.every((id) => expanded.has(id))
      )
        olderAnchor.current = undefined;
    }
    if (targetAnchor.current !== undefined) {
      // Ordinary prepends belong exclusively to Virtua. A late ancestor can
      // reparent an exact reply; preserve its viewport position only until the
      // remaining history is exhausted (or newer input retires it).
      const offset = selectedOffset();
      if (!prepend && offset !== undefined)
        correctScrollTop(element, offset - targetAnchor.current);
      if (snapshot.status !== "loading" && !snapshot.canLoadMore)
        targetAnchor.current = undefined;
    }
    let frame = 0;
    const revealPosition = () => {
      if (positioned.current || intent.current !== scheduledIntent) return;
      if (follow.current && branches.length) {
        const last = element.querySelector<HTMLElement>(
          `[data-message-id="${branches.at(-1)?.id}"]`,
        );
        if (
          !last ||
          getComputedStyle(last).visibility === "hidden" ||
          Math.abs(
            element.scrollHeight - element.clientHeight - element.scrollTop,
          ) > 1
        )
          return;
      }
      reveal();
    };
    const reveal = () => {
      if (positioned.current) return;
      positioned.current = true;
      setInitialPositioned(true);
      measuredPosition.current = {
        offset: element.scrollTop,
        height: element.scrollHeight,
      };
      readingPositioned(element);
      const bottom =
        element.scrollHeight - element.clientHeight - element.scrollTop < 80;
      setShowJumpToLatest(!bottom);
      if (bottom) setNewMessageCount(0);
    };
    const followLatest = () => {
      if (!follow.current) return;
      if (!branches.length) {
        // A root-only thread has no virtual item to target.
        correctScrollTop(
          element,
          element.scrollHeight - element.clientHeight - element.scrollTop,
        );
        return;
      }
      virtualizer.current?.scrollToIndex(branches.length - 1, {
        align: "end",
        offset: Number.parseFloat(getComputedStyle(element).paddingBottom) || 0,
      });
    };
    // Virtua's imperative target expires after measurement settles. Media can
    // grow later: renew bottom intent on committed extent changes, not on
    // scroll events. Measurement and prepend corrections remain Virtua-owned.
    const list = element.querySelector<HTMLOListElement>(
      "[data-thread-rows] > ol",
    );
    let height = list?.style.height;
    const observer = new MutationObserver(() => {
      if (list?.style.height === height) return;
      height = list?.style.height;
      followLatest();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(revealPosition);
    });
    if (list)
      observer.observe(list, { attributes: true, attributeFilter: ["style"] });
    followLatest();
    frame = requestAnimationFrame(revealPosition);
    // Geometry must never leave an otherwise usable thread invisible forever.
    // This releases presentation only; it does not claim the bottom was reached.
    const deadline = !positioned.current
      ? setTimeout(
          () => {
            if (intent.current === scheduledIntent) reveal();
          },
          Math.max(
            0,
            1000 -
              (performance.now() -
                (positioningStarted.current ?? performance.now())),
          ),
        )
      : undefined;
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(deadline);
      observer.disconnect();
    };
  }, [
    size,
    prepend,
    active,
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
  }, [active, navigation, rootTarget, revealed, snapshot, initialPositioned]);
  // An own send can land in the middle of a branch, not at the list bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry DOM lookup after history or branch visibility changes.
  useLayoutEffect(() => {
    if (!sent) return;
    const frame = requestAnimationFrame(() => {
      const row = [
        ...(scroller.current?.querySelectorAll<HTMLElement>(
          "[data-message-id]",
        ) ?? []),
      ].find((element) => element.dataset.messageId === sent);
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        setSent(undefined);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [sent, snapshot.replies, expanded]);
  const jumpToLatest = () => {
    const element = scroller.current;
    if (!element) return;
    intent.current++;
    olderAnchor.current = undefined;
    targetAnchor.current = undefined;
    positioned.current = true;
    follow.current = true;
    element.focus({ preventScroll: true });
    setShowJumpToLatest(false);
    setNewMessageCount(0);
    virtualizer.current?.scrollToIndex(branches.length - 1, {
      align: "end",
      offset: Number.parseFloat(getComputedStyle(element).paddingBottom) || 0,
    });
  };
  const keepReadingPosition = () => {
    intent.current++;
    olderAnchor.current = undefined;
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
          keepMounted={keepRowMounted}
          {...(canSeekVideo ? { onMediaTime: handleMediaTime } : {})}
          {...(onOpenMediaReview && rootId
            ? { onOpenMediaReview: openRootMedia }
            : {})}
        />
      );
      const Item = depth === 0 ? "div" : "li";
      return (
        <Item
          key={row.id}
          ref={row.id === messageId ? selectedBranchRef : undefined}
          className={styles.replyItem}
          data-layout={continuation ? "continuation" : "thread"}
          data-reply-id={row.id}
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
              setFocusedId(row.id);
              intent.current++;
              follow.current = false;
              olderAnchor.current = undefined;
              targetAnchor.current = undefined;
              setExpanded((current) => new Set([...current, row.id]));
            }}
          >
            {expanded.has(row.id) && (
              <ol>{renderReplies(row.id, depth + 1)}</ol>
            )}
          </ReplyBranch>
        </Item>
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
  const keptIndices = [
    ...new Set([
      ...[
        focusedId,
        sent,
        olderAnchor.current?.id,
        ...(navigation && !rootTarget ? [messageId] : []),
        ...pinnedIds,
      ]
        .map(branchIndex)
        .filter((index) => index >= 0),
    ]),
  ];
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
        aria-label="Thread messages"
        aria-busy={positioning}
        data-positioning={positioning || undefined}
        onScroll={(event) => {
          if (!positioned.current) return;
          const element = event.currentTarget;
          if (olderAnchor.current) {
            const anchor = olderAnchor.current;
            const row = [
              ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
            ].find((row) => row.dataset.messageId === anchor.id);
            if (row) anchor.top = row.getBoundingClientRect().top;
          }
          const distance =
            element.scrollHeight - element.clientHeight - element.scrollTop;
          const previous = measuredPosition.current;
          const movedUp =
            element.scrollTop < previous.offset &&
            element.scrollHeight >= previous.height;
          // An upward gesture leaves follow mode immediately. Only movement back
          // toward the end may use the near-bottom reattachment threshold.
          follow.current = movedUp
            ? distance <= 1
            : follow.current || distance < 80;
          measuredPosition.current = {
            offset: element.scrollTop,
            height: element.scrollHeight,
          };
          setShowJumpToLatest(!follow.current);
          if (follow.current) setNewMessageCount(0);
          loadOlder();
        }}
        onFocus={(event) =>
          setFocusedId(
            event.target.closest<HTMLElement>("[data-reply-id]")?.dataset
              .replyId,
          )
        }
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setFocusedId(undefined);
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
        {showJumpToLatest && (
          <JumpToLatestButton
            newMessageCount={newMessageCount}
            onClick={jumpToLatest}
          />
        )}
        <div data-thread-rows="" inert={positioning}>
          <div ref={intro}>
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
            {showOlderPageStatus && snapshot.error && (
              <div className={styles.threadHistoryPageStatus}>
                <p role="alert">{snapshot.error}</p>
                <Button type="button" onClick={retryThread}>
                  Retry thread
                </Button>
              </div>
            )}
          </div>
          {size.width > 0 && size.height > 0 && (
            <Virtualizer
              ref={virtualizer}
              scrollRef={scroller}
              shift={prepend}
              bufferSize={1600}
              keepMounted={keptIndices}
              startMargin={size.introHeight}
              as="ol"
              item="li"
            >
              {renderReplies(undefined)}
            </Virtualizer>
          )}
        </div>
        {positioning || (snapshot.status === "loading" && !rows.length) ? (
          <p role="status">Loading thread…</p>
        ) : null}
        {snapshot.targetStatus === "unavailable" && (
          <p role="status">Selected message unavailable.</p>
        )}
        {snapshot.error && !showOlderPageStatus && (
          <p role="alert">{snapshot.error}</p>
        )}
        {snapshot.limited && !snapshot.error && (
          <p className={styles.threadNote}>Thread history limit reached.</p>
        )}
        {((snapshot.error && !showOlderPageStatus) ||
          snapshot.targetStatus === "unavailable") && (
          <div className={styles.threadHistoryControls}>
            <Button type="button" onClick={() => void view.refresh()}>
              Retry thread
            </Button>
          </div>
        )}
      </section>
      {snapshot.root && (
        <MessageComposer
          sessionConversation={sessionConversation}
          key={`${scope}:${channelId}:${snapshot.root.id}`}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          placeholder={`Reply in thread to ${resolveName(snapshot.root.authorId, profiles.get(snapshot.root.authorId)?.name ?? formatPublicKey(snapshot.root.authorId) ?? "Unknown author")}`}
          threadRootId={snapshot.root.id}
          replyParentId={replyParent}
          disabled={!!replyParent && !selectedParent}
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
          onSend={(id) => {
            intent.current++;
            olderAnchor.current = undefined;
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
