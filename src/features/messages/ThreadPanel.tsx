// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The thread region supports keyboard scrolling and Escape.
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
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { MessageRow } from "./MessageRow";
import { MessageComposer } from "./MessageComposer";
import styles from "./Messages.module.css";
import { rejectUnhandledFileDrop } from "./use-file-drop";
import { useReading } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import type { MediaPlayback } from "./MediaAttachment";
import { formatMediaTime } from "./media-timecode";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { pendingAgentRequest } from "./agent-request";
import { threadAgentGroups, isAgentCoordination } from "./thread-agent-groups";
import { ThreadAgentGroup } from "./ThreadAgentGroup";
import { ComposerAccessories } from "../conversation/ComposerAccessories";

export type ThreadPanelProps = {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelName: string;
  channelId: string;
  sessionConversation?: boolean | undefined;
  messageId: string;
  replyRequest?: number | undefined;
  navigation?: PageNavigation | undefined;
  close(): void;
  onOpenLink(url: string): boolean;
  onOpenMediaReview?(
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
  ): void;
  canOpenLink?: ((target: string) => boolean) | undefined;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ThreadPanel(props: ThreadPanelProps) {
  return (
    <aside
      className={styles.thread}
      data-attachment-drop-zone=""
      onDragOver={rejectUnhandledFileDrop}
      onDrop={rejectUnhandledFileDrop}
      aria-label="Thread"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.close();
        }
      }}
    >
      <ThreadHeader close={props.close} />
      <OwnedThreadPanel
        key={messageViewKey(
          props.session,
          props.scope,
          props.channelId,
          props.messageId,
        )}
        {...props}
      />
    </aside>
  );
}
function ThreadHeader({ close }: Pick<ThreadPanelProps, "close">) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  return (
    <PanelHeader
      variant="compact"
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
  const request = useMemo(
    () =>
      pendingAgentRequest(
        rows,
        session.viewer,
        agentPubkeys,
        snapshot.root?.id,
      ),
    [rows, session.viewer, agentPubkeys, snapshot.root?.id],
  );
  // Use the same cached exact-agent evidence as the rest of this thread,
  // including profile hints, rather than a narrower second inventory view.
  const groupAgents = new Set(agentPubkeys);
  if (session.viewer) groupAgents.delete(session.viewer);
  // A visible descendant breaks coordination collapse along its loaded ancestry.
  // Ordinary non-coordination branches retain main's explicit branch controls.
  const byId = new Map(snapshot.replies.map((row) => [row.id, row]));
  const visibleAncestors = new Set(
    snapshot.replies
      .filter(
        (row) =>
          !isAgentCoordination(row, groupAgents, session.viewer) &&
          tree.ancestors(row.id).some((id) => {
            const ancestor = byId.get(id);
            return (
              ancestor &&
              isAgentCoordination(ancestor, groupAgents, session.viewer)
            );
          }),
      )
      .flatMap((row) => tree.ancestors(row.id)),
  );
  // Keep the active reply target reachable if new identity evidence regroups it.
  if (replyParent) {
    visibleAncestors.add(replyParent);
    for (const id of tree.ancestors(replyParent)) visibleAncestors.add(id);
  }
  const collapsedReveal = useRef<AbortSignal | undefined>(undefined);
  const accessoryTail = useRef<HTMLOListElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const positioned = useRef(false);
  const follow = useRef(true);
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
        // retain focus intent after this update (collapse, deletion, or unmount).
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
    navigation?.complete({ status: "opened" });
  }, [navigation, selectedOffset]);
  const prepareTarget = useCallback(() => {
    follow.current = false;
  }, []);
  const revealedAncestors = useRef(new Set<string>());
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
  const revealed = useMessageReveal({
    scroller,
    settled: positioned,
    messageId,
    signal: rootTarget ? undefined : navigation?.signal,
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
  useReading({ session, channelId, scroller, settled: positioned });
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
  const [mediaPlayback, setMediaPlayback] = useState<MediaPlayback>();
  const [mediaCommentTime, setMediaCommentTime] = useState<number>();
  const [mediaSeek, setMediaSeek] = useState<{
    seconds: number;
    request: number;
  }>();
  const handleMediaTime = useCallback((seconds: number) => {
    setMediaSeek((current) => ({
      seconds,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);
  const rootId = snapshot.root?.id;
  const openRootMedia = useCallback(
    (
      _rowId: string,
      attachment: ChannelMessage["attachments"][number],
      seconds: number,
    ) => {
      if (rootId) onOpenMediaReview?.(_rowId, attachment, seconds);
    },
    [rootId, onOpenMediaReview],
  );
  const videoAttachment = snapshot.root?.attachments.find(
    (item) => item.kind === "video",
  );
  // The bridge walks oldest-first. Finish its bounded range automatically, rather
  // than exposing transport pagination as a conversation control.
  useEffect(() => {
    if (snapshot.status === "ready" && snapshot.canLoadMore)
      void view.loadMore();
  }, [view, snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rendered rows/profiles change scroll height; sending is explicit navigation intent.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || navigation?.signal.aborted) return;
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
        (snapshot.status !== "ready" || snapshot.canLoadMore))
    )
      return;
    if (targetAnchor.current !== undefined) {
      const offset = selectedOffset();
      if (offset !== undefined) {
        element.scrollTop += offset - targetAnchor.current;
        targetAnchor.current = offset;
        follow.current = false;
      }
      if (snapshot.status !== "loading" && !snapshot.canLoadMore)
        targetAnchor.current = undefined;
    }
    // Initial positioning waits for automatic history loading. User intent wins;
    // subsequent live changes follow only while the reader is at the bottom.
    if (follow.current) element.scrollTop = element.scrollHeight;
    positioned.current = true;
  }, [
    snapshot.status,
    snapshot.canLoadMore,
    snapshot.root,
    messageId,
    rows,
    profiles,
    sent,
    navigation,
    rootTarget,
    revealed,
    selectedOffset,
  ]);
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
  const keepReadingPosition = () => {
    targetAnchor.current = undefined;
    if (positioned.current) return;
    positioned.current = true;
    follow.current = false;
  };
  useLayoutEffect(() => {
    const tail = accessoryTail.current;
    if (!tail) return;
    const observer = new ResizeObserver(() => {
      const element = scroller.current;
      if (element && positioned.current && follow.current)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(tail);
    return () => observer.disconnect();
  }, []);
  const renderActivity = (pending: typeof request) =>
    snapshot.root && extensions?.accessories ? (
      <ComposerAccessories
        registry={extensions.accessories}
        placement="conversation"
        session={session}
        scope={scope}
        channelId={channelId}
        threadRootId={snapshot.root.id}
        request={pending}
        canOpen={(target) => canOpenLink?.(target) ?? false}
        open={onOpenLink}
      />
    ) : null;
  // Each parent owns its sibling sequence; never flatten ancestry to form a group.
  const requestBranch =
    request &&
    request.message.id !== snapshot.root?.id &&
    ((request.message.replyParentId &&
      request.message.replyParentId !== snapshot.root?.id) ||
      tree.children.has(request.message.id));
  const blocksFor = (parent: string | undefined) =>
    threadAgentGroups(
      parent ? byId.get(parent) : snapshot.root,
      tree.children.get(parent) ?? [],
      groupAgents,
      requestBranch && parent !== request?.message.id ? undefined : request,
      session.viewer,
      visibleAncestors,
    );
  function renderReplies(parent: string | undefined, depth = 0): ReactNode {
    return blocksFor(parent).map((block) => {
      if (block.kind === "message")
        return renderReply(block.row, parent, depth);
      // A disclosure is a visual boundary even when its children are unmounted.
      // Do not omit an answer's byline because a hidden coordination row matched it.
      previousReply = undefined;
      const group = (
        <li key={`agents:${block.id}`}>
          <ThreadAgentGroup
            block={block}
            session={session}
            profiles={profiles}
            coordination={
              <ol>
                {block.rows.map((row) => renderReply(row, parent, depth))}
              </ol>
            }
            reveal={
              !rootTarget &&
              collapsedReveal.current !== navigation?.signal &&
              block.rows.some(
                (row) =>
                  row.id === messageId ||
                  tree.ancestors(messageId).includes(row.id),
              )
                ? navigation?.signal
                : undefined
            }
            onHideCoordination={() => {
              if (
                block.rows.some(
                  (row) =>
                    row.id === messageId ||
                    tree.ancestors(messageId).includes(row.id),
                )
              )
                collapsedReveal.current = navigation?.signal;
            }}
          >
            {block.request
              ? renderActivity(block.request)
              : !parent && block.tail
                ? renderActivity(undefined)
                : null}
          </ThreadAgentGroup>
        </li>
      );
      previousReply = undefined;
      return group;
    });
  }
  let previousReply: ChannelMessage | undefined = snapshot.root;
  function renderReply(
    row: ChannelMessage,
    parent: string | undefined,
    depth: number,
  ): ReactNode {
    const children = tree.children.get(row.id);
    const ownsPending = requestBranch && request?.message.id === row.id;
    const continuation =
      previousReply?.authorId === row.authorId &&
      row.createdAt >= previousReply.createdAt &&
      row.createdAt - previousReply.createdAt <= 10 * 60 &&
      !row.membership;
    previousReply =
      children?.length && !expanded.has(row.id) && !visibleAncestors.has(row.id)
        ? undefined
        : row;
    const descendants = branchReplies.get(row.id) ?? [];
    const unreadCount = descendants.filter(
      (reply) => session.unread.attention(channelId, reply.id).unread,
    ).length;
    const unreadLabel = unreadCount
      ? `${unreadCount} new in available replies`
      : undefined;
    const message = (branchControl?: ReactNode) => (
      <MessageRow
        branchControl={branchControl}
        extensions={extensions}
        session={session}
        scope={scope}
        onReply={snapshot.root ? targetReply : undefined}
        row={row}
        {...(rootId ? { conversationThreadRootId: rootId } : {})}
        profile={profiles.get(row.authorId)}
        participantProfiles={profiles}
        agentPubkeys={agentPubkeys}
        media={session.media}
        onOpenLink={onOpenLink}
        canOpenLink={canOpenLink}
        day={false}
        layout={continuation ? "continuation" : "thread"}
        retry={session.messages.retry}
        {...(videoAttachment ? { onMediaTime: handleMediaTime } : {})}
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
          collapsible={!!children?.length && !visibleAncestors.has(row.id)}
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
          open={expanded.has(row.id) || visibleAncestors.has(row.id)}
          onOpenChange={(open) => {
            follow.current = false;
            targetAnchor.current = undefined;
            setExpanded((current) => {
              const next = new Set(current);
              if (open) next.add(row.id);
              else {
                next.delete(row.id);
                for (const id of current)
                  if (tree.ancestors(id).includes(row.id)) next.delete(id);
              }
              return next;
            });
          }}
        >
          {(expanded.has(row.id) || visibleAncestors.has(row.id)) && (
            <ol>{renderReplies(row.id, depth + 1)}</ol>
          )}
        </ReplyBranch>
        {ownsPending && !children?.length && (
          <ol>{renderReplies(row.id, depth + 1)}</ol>
        )}
      </li>
    );
  }
  const selectedParent = snapshot.replies.find((row) => row.id === replyParent);
  return (
    <>
      <section
        ref={scroller}
        className={styles.threadHistory}
        aria-label="Thread messages"
        onScroll={(event) => {
          if (!positioned.current) return;
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            80;
        }}
        onWheel={keepReadingPosition}
        onTouchMove={keepReadingPosition}
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
          )
            keepReadingPosition();
        }}
        tabIndex={0}
      >
        {snapshot.root ? (
          <>
            <MessageRow
              extensions={extensions}
              session={session}
              scope={scope}
              onReply={focusReply}
              row={snapshot.root}
              conversationThreadRootId={snapshot.root.id}
              profile={profiles.get(snapshot.root.authorId)}
              participantProfiles={profiles}
              agentPubkeys={agentPubkeys}
              media={session.media}
              onOpenLink={onOpenLink}
              canOpenLink={canOpenLink}
              day={false}
              layout="thread"
              retry={session.messages.retry}
              mediaMode="thread"
              {...(mediaSeek
                ? {
                    mediaSeekTo: mediaSeek.seconds,
                    mediaSeekRequest: mediaSeek.request,
                  }
                : {})}
              onMediaPlayback={setMediaPlayback}
              {...(onOpenMediaReview
                ? { onOpenMediaReview: openRootMedia }
                : {})}
            />
            {videoAttachment && mediaPlayback && (
              <span className={styles.mediaCommentAction}>
                <Button
                  size="sm"
                  type="button"
                  onClick={() => setMediaCommentTime(mediaPlayback.seconds)}
                >
                  Comment at {formatMediaTime(mediaPlayback.seconds)}
                </Button>
              </span>
            )}
          </>
        ) : snapshot.status !== "loading" ? (
          <p className={styles.empty}>Original message unavailable.</p>
        ) : null}
        <div className={styles.threadDivider}>
          {snapshot.replies.length}{" "}
          {snapshot.replies.length === 1 ? "reply" : "replies"}
          {request?.agents.length && request.message.delivery !== "failed"
            ? ` · ${request.agents.length} pending`
            : ""}
        </div>
        <ol ref={accessoryTail}>
          {renderReplies(undefined)}
          {!blocksFor(undefined).some(
            (block) => block.kind === "agents" && block.tail,
          ) &&
            extensions?.accessories && <li>{renderActivity(undefined)}</li>}
        </ol>
        {(snapshot.status === "loading" ||
          (snapshot.status === "ready" && snapshot.canLoadMore)) && (
          <p role="status">Loading thread…</p>
        )}
        {snapshot.targetStatus === "unavailable" && (
          <p role="status">Selected message unavailable.</p>
        )}
        {snapshot.error && <p role="alert">{snapshot.error}</p>}
        {snapshot.limited && !snapshot.error && (
          <p className={styles.threadNote}>Thread history limit reached.</p>
        )}
        {(snapshot.error || snapshot.targetStatus === "unavailable") && (
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
          {...(videoAttachment && mediaCommentTime !== undefined
            ? { mediaTimeSeconds: mediaCommentTime }
            : {})}
          clearMediaTime={() => setMediaCommentTime(undefined)}
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
    </>
  );
}
