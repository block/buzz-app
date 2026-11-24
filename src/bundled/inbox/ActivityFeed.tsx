import { reactionRows } from "./reaction-rows";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { useIdentityNames } from "../../features/identity-names/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import {
  useChannelList,
  useProfileGeneration,
} from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { ChecksIcon, EnvelopeOpenIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { shortRelativeTimestamp } from "../../shared/relative-timestamp";
import {
  hasUnread,
  InboxRowButton,
  ownIdentity,
  ReactionRowButton,
  rowIdentity,
  rowProfileIds,
} from "./InboxRow";
import { withMentionedIds } from "../../features/messages/PreviewText";
import { activityConversation, useActivityMutes } from "./useActivityMutes";
import type { InboxItem } from "../../features/relay/inbox";
import { useOwnActivity, withOwnActivity } from "./own-activity";
import listRowStyles from "../../features/messages/MessageListRow.module.css";
import styles from "./InboxPreview.module.css";

/** Rows a compact feed renders and enriches; the Activity page holds the rest. */
const maxRows = 50;

/** What a compact feed lists: everything, mentions of you, or your threads. */
export type FeedView = "all" | "mentions" | "threads";

/** The row's explicit read, as Activity's Mark as read saves it. */
async function readRow(session: RelaySession, item: InboxItem) {
  if (item.target.kind === "channel")
    await session.unread.prepareChannelRead(item.channelId)();
  else if (item.timeline)
    await session.unread.markTimelineRead(item.channelId, item.messageIds);
  // One intent across its steps: a newer Mark as unread stops the rest.
  else await session.unread.markReadThrough(item.readThrough);
}

/** Where a row opens, for opening it and for showing which row is open. */
export type FeedDestination = Readonly<{
  channelId: string;
  messageId: string;
  rootId?: string | undefined;
}>;

/**
 * Activity's compact list, newest first: conversations by their newest
 * message from anyone, yours included, and in All the reactions to your
 * messages. Shared by the Activity row's hover card and the sidebar card.
 */
export function ActivityFeed({
  session,
  scope,
  navigator,
  view = "all",
  unreadOnly = false,
  onUnreadOnlyChange,
  focusFallback,
  isOpen,
  onOpen,
  unreadFirst = false,
  showTime = true,
  openChannelId,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  view?: FeedView;
  unreadOnly?: boolean;
  onUnreadOnlyChange?: (value: boolean) => void;
  /** Where focus goes when Mark as read leaves an empty list. */
  focusFallback?: RefObject<HTMLElement | null>;
  /** Whether a row's conversation is the one open now, to show it selected. */
  isOpen?: (destination: FeedDestination) => boolean;
  /** Before a row opens its conversation. */
  onOpen?: () => void;
  /** Unread conversations lead, each part newest first. */
  unreadFirst?: boolean;
  /** Whether rows show when their latest message was sent. */
  showTime?: boolean;
  /** The conversation open now. A row opened while unread keeps its place
   * and look until another conversation opens. */
  openChannelId?: string | undefined;
}) {
  const list = useChannelList(session.channels);
  const muted = useActivityMutes(session);
  const own = useOwnActivity(session, scope.viewer, list.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const feed = useSyncExternalStore(
    session.inboxFeed.subscribe,
    session.inboxFeed.snapshot,
    session.inboxFeed.snapshot,
  );
  const reactions = useSyncExternalStore(
    session.inboxFeed.reactions.subscribe,
    session.inboxFeed.reactions.snapshot,
    session.inboxFeed.reactions.snapshot,
  );
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const [refreshAfterRoster, setRefreshAfterRoster] = useState(false);
  useEffect(() => {
    // As on the page, a completed discovery revision can retire a feed attempt.
    void list.asOf;
    if (list.status !== "ready") return;
    // Retry after a roster failure also refreshes activity that failed meanwhile.
    if (refreshAfterRoster) {
      setRefreshAfterRoster(false);
      void Promise.all([
        session.unread.refresh(),
        session.inboxFeed.refresh(),
        session.inboxFeed.reactions.refresh(),
      ]);
    } else {
      void session.unread.ensure();
      void session.inboxFeed.ensure();
      void session.inboxFeed.reactions.ensure();
    }
  }, [session, list.status, list.asOf, refreshAfterRoster]);
  const channelOf = (channelId: string) =>
    list.channels.find((channel) => channel.id === channelId);
  const conversations = inbox.items
    .map((item) =>
      view === "mentions" ? item.mention : activityConversation(item, muted),
    )
    .filter(
      (item): item is InboxItem =>
        item !== undefined && (view !== "threads" || item.thread),
    );
  // Mentions are about what others said; elsewhere your own messages count.
  const conversationRows = withOwnActivity(
    unreadOnly ? conversations.filter(hasUnread) : conversations,
    inbox.items,
    view === "mentions" ? new Map() : own,
    (mine) => !unreadOnly && (view === "all" || !!mine.rootId),
  );
  // Only someone else's message makes a row unread; yours and reactions never do.
  // A row opened while unread keeps its place while it stays open; once you
  // move on, it settles among the rest by when it was last active.
  const [held, setHeld] =
    useState<Readonly<{ channelId: string; ids: readonly string[] }>>();
  const unreadIds = new Set(
    conversationRows.flatMap((row) =>
      row.kind === "conversation" &&
      (hasUnread(row.item) ||
        (!!held &&
          held.channelId === openChannelId &&
          held.ids.includes(row.item.id)))
        ? [row.item.id]
        : [],
    ),
  );
  const activity = [
    ...conversationRows,
    ...(view === "all" && !unreadOnly
      ? reactionRows(
          reactions.items.filter(
            (item) =>
              !muted.has(item.channelId) ||
              channelOf(item.channelId)?.channelType === "dm",
          ),
        )
      : []
    ).map((item) => ({
      kind: "reaction" as const,
      item,
      createdAt: item.createdAt,
    })),
  ].map((row) => ({
    ...row,
    id: row.kind === "own" ? row.own.id : row.item.id,
  }));
  // One row per conversation: a channel's main conversation, each thread, a
  // DM or a chat. Its newest activity, from anyone, stands for it, and it is
  // unread while any of someone else's messages in it are.
  const conversationOf = (row: (typeof activity)[number]) => {
    const where =
      row.kind === "own"
        ? row.own
        : row.kind === "reaction"
          ? {
              channelId: row.item.channelId,
              rootId: row.item.message.threadRootId,
            }
          : { channelId: row.item.channelId, rootId: row.item.rootId };
    return channelOf(where.channelId)?.channelType === "dm" || !where.rootId
      ? where.channelId
      : `${where.channelId}:${where.rootId}`;
  };
  const groups = new Map<
    string,
    { row: (typeof activity)[number]; unread: InboxItem[] }
  >();
  for (const row of activity) {
    const key = conversationOf(row);
    const group = groups.get(key) ?? { row, unread: [] };
    if (
      row.createdAt > group.row.createdAt ||
      (row.createdAt === group.row.createdAt && row.id < group.row.id)
    )
      group.row = row;
    if (row.kind === "conversation" && unreadIds.has(row.id))
      group.unread.push(row.item);
    groups.set(key, group);
  }
  const rows = [...groups.values()]
    .map(({ row, unread }) => ({ ...row, unread }))
    .sort(
      (a, b) =>
        (unreadFirst
          ? Number(b.unread.length > 0) - Number(a.unread.length > 0)
          : 0) ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    )
    .slice(0, maxRows);
  const profileKey = withMentionedIds(
    [
      scope.viewer,
      ...rows.flatMap((row) =>
        row.kind === "own"
          ? rowProfileIds({}, channelOf(row.own.channelId))
          : [
              ...(row.kind === "reaction"
                ? row.item.events.map((event) => event.pubkey)
                : [row.item.authorId]),
              ...rowProfileIds(
                row.kind === "reaction" ? {} : row.item,
                channelOf(row.item.channelId),
              ),
            ],
      ),
    ],
    rows.flatMap((row) =>
      row.kind === "reaction"
        ? [row.item.message]
        : row.kind === "own"
          ? [row.own.preview]
          : [row.item.previewMentions, ...(row.own ? [row.own.preview] : [])],
    ),
  )
    .sort()
    .join(":");
  const profileIds = useMemo(
    () => (profileKey ? profileKey.split(":") : []),
    [profileKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, profileIds),
    [session, profileIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (profileIds.length && list.status === "ready")
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, profileGeneration]);

  const loading =
    list.status === "idle" ||
    list.status === "loading" ||
    inbox.status === "loading" ||
    feed.status === "loading" ||
    reactions.status === "loading";
  // As on the page, an empty result is only shown once activity was checked.
  const checked =
    inbox.status === "ready" ||
    feed.status === "ready" ||
    reactions.status === "ready";
  const failure =
    list.error ?? inbox.error ?? feed.error ?? reactions.error ?? sync.error;
  const retry = async () => {
    if (list.status !== "ready") {
      setRefreshAfterRoster(true);
      session.channels.ensureList();
    } else
      await Promise.all([
        session.unread.refresh(),
        session.inboxFeed.refresh(),
        session.inboxFeed.reactions.refresh(),
      ]);
    await session.unread.retrySync();
  };
  const notify = useToastNotification();
  const listRef = useRef<HTMLUListElement>(null);
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const canRead = sync.capability === "frontier-sync";
  /** Mark as read keeps focus in the list when its action leaves: on its
   * row, which stays read, or when Unread only drops the row, on a neighbor. */
  const feedRows = () => [
    ...(listRef.current?.querySelectorAll<HTMLElement>("[data-preview-row]") ??
      []),
  ];
  /** Reads every unread message in the conversation a row stands for. */
  const markRead = async (rowId: string, items: readonly InboxItem[]) => {
    if (reading.has(rowId)) return;
    const before = feedRows();
    const held = before.some(
      (row) =>
        row.dataset.previewRow === rowId &&
        row.contains(document.activeElement),
    );
    const order = before.map((row) => row.dataset.previewRow);
    const index = order.indexOf(rowId);
    setReading((current) => new Set(current).add(rowId));
    try {
      for (const item of items) await readRow(session, item);
    } catch {
      notify("Couldn't mark as read", "error");
    } finally {
      setReading((current) => {
        const next = new Set(current);
        next.delete(rowId);
        return next;
      });
    }
    if (!held) return;
    requestAnimationFrame(() => {
      // Only focus the action took with it when it left: a failed read keeps
      // its action, and focus elsewhere stays where the user put it. When
      // Unread only empties the list, the fallback takes focus.
      const focused = document.activeElement;
      if (focused && focused !== document.body) return;
      const current = feedRows();
      const row = [rowId, order[index + 1], order[index - 1]]
        .map((id) =>
          current
            .find((entry) => entry.dataset.previewRow === id)
            ?.querySelector<HTMLElement>("button"),
        )
        .find(Boolean);
      (row ?? focusFallback?.current)?.focus({ preventScroll: true });
    });
  };
  const retryFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);
  useLayoutEffect(() => {
    if (!retryFocus.current) return;
    retryFocus.current = false;
    // A recovered Retry hands its focus to the feed's owner, as on the page.
    if (failure || document.activeElement !== document.body) return;
    focusFallback?.current?.focus({ preventScroll: true });
  }, [failure, focusFallback]);
  const destination = (row: (typeof rows)[number]): FeedDestination =>
    row.kind === "reaction"
      ? {
          channelId: row.item.channelId,
          messageId: row.item.message.id,
          rootId: row.item.message.threadRootId,
        }
      : row.kind === "own"
        ? row.own
        : row.item;
  const open = (row: (typeof rows)[number]) => {
    const item = destination(row);
    setHeld({
      channelId: item.channelId,
      ids: row.unread.map((unread) => unread.id),
    });
    onOpen?.();
    void navigator.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId: item.channelId,
      messageId: item.messageId,
      ...(item.rootId && { threadRootId: item.rootId }),
    });
  };
  const empty =
    view === "mentions"
      ? {
          title: "No mentions",
          description: "Messages that mention you appear here.",
        }
      : view === "threads"
        ? {
            title: "No threads",
            description: "Threads you've written in appear here.",
          }
        : unreadOnly
          ? {
              title: "You're all caught up",
              description:
                "No unread mentions, direct messages, or thread replies.",
            }
          : {
              title: "No recent activity",
              description:
                "Mentions, direct messages, thread replies, reactions to your messages, and your own recent messages appear here.",
            };
  return (
    <>
      {failure && (
        <div className={styles.notice} role="alert">
          <p className="text-body">{failure}</p>
          <Button ref={retryButton} size="sm" onClick={() => void retry()}>
            Retry activity
          </Button>
        </div>
      )}
      {rows.length ? (
        <ul
          ref={listRef}
          className={styles.list}
          aria-label="Recent activity"
          data-unread-emphasis="weight"
        >
          {rows.map((row) => {
            const selected = isOpen?.(destination(row)) ?? false;
            const unread = row.unread.length > 0;
            const readAction = (label: string) =>
              canRead &&
              unread && (
                <span className={listRowStyles.unreadAction}>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    loading={reading.has(row.id)}
                    aria-label={`Mark as read ${label}`}
                    title="Mark as read"
                    onClick={() => void markRead(row.id, row.unread)}
                    icon={<EnvelopeOpenIcon size={16} aria-hidden="true" />}
                  />
                </span>
              );
            if (row.kind === "reaction")
              return (
                <li
                  key={row.id}
                  className={listRowStyles.unreadActionHost}
                  data-preview-row={row.id}
                >
                  <ReactionRowButton
                    item={row.item}
                    session={session}
                    profiles={profiles}
                    name={name}
                    channel={channelOf(row.item.channelId)}
                    time={
                      showTime ? shortRelativeTimestamp(row.createdAt) : null
                    }
                    unread={unread}
                    selected={selected}
                    onClick={() => open(row)}
                  />
                  {readAction(
                    `reactions in ${channelOf(row.item.channelId)?.name ?? "this conversation"}`,
                  )}
                </li>
              );
            if (row.kind === "own")
              return (
                <li
                  key={row.id}
                  className={listRowStyles.unreadActionHost}
                  data-preview-row={row.id}
                >
                  <InboxRowButton
                    own={row.own}
                    identity={ownIdentity(
                      scope.viewer,
                      channelOf(row.own.channelId),
                      profiles,
                      name,
                    )}
                    session={session}
                    feed={feed}
                    time={
                      showTime ? shortRelativeTimestamp(row.createdAt) : null
                    }
                    unread={unread}
                    selected={selected}
                    onClick={() => open(row)}
                  />
                  {readAction(
                    `your message in ${channelOf(row.own.channelId)?.name ?? "this conversation"}`,
                  )}
                </li>
              );
            const item = row.item;
            const channel = channelOf(item.channelId);
            const identity = row.own
              ? ownIdentity(scope.viewer, channel, profiles, name)
              : rowIdentity(item, channel, profiles, name);
            return (
              <li
                key={row.id}
                className={listRowStyles.unreadActionHost}
                data-preview-row={row.id}
              >
                <InboxRowButton
                  item={item}
                  own={row.own}
                  identity={identity}
                  session={session}
                  feed={feed}
                  time={showTime ? shortRelativeTimestamp(row.createdAt) : null}
                  unread={unread}
                  selected={selected}
                  onClick={() => open(row)}
                />
                {readAction(`${identity.sender} in ${identity.context}`)}
              </li>
            );
          })}
        </ul>
      ) : loading ? (
        [0, 1, 2].map((row) => (
          <div className={styles.placeholderRow} key={row} aria-hidden="true">
            <span className={styles.placeholderAvatar} />
            <span className={styles.placeholderLines}>
              <span className={styles.placeholderLine} />
              <span className={styles.placeholderLine} />
              <span className={styles.placeholderLine} />
            </span>
          </div>
        ))
      ) : failure || !checked ? null : (
        <div className={styles.empty} role="status">
          <EmptyState
            frame="none"
            level={4}
            icon={<ChecksIcon />}
            title={empty.title}
            description={empty.description}
            action={
              unreadOnly &&
              onUnreadOnlyChange &&
              (conversations.length || own.size || reactions.items.length) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onUnreadOnlyChange(false)}
                >
                  Show recent activity
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
    </>
  );
}

/** The unread line over a compact feed: how many conversations need you, and
 * of what kind, as the page's filters with Unread only would list them. */
export function useActivitySummary(session: RelaySession) {
  const list = useChannelList(session.channels);
  const muted = useActivityMutes(session);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const unread = inbox.items
    .map((item) => activityConversation(item, muted))
    .filter((item): item is InboxItem => item !== undefined && hasUnread(item));
  // Each conversation counts once, under its most specific kind. A Solo
  // chat's own row has no kind, so the total leads.
  let dms = 0;
  let mentions = 0;
  let threads = 0;
  for (const item of unread) {
    const channel = list.channels.find(
      (candidate) => candidate.id === item.channelId,
    );
    if (channel?.channelType === "dm") dms++;
    else if (item.mentioned && hasUnread(item.mention ?? item)) mentions++;
    else if (item.thread) threads++;
  }
  const kinds = [
    mentions && `${mentions} ${mentions === 1 ? "mention" : "mentions"}`,
    threads && `${threads} ${threads === 1 ? "thread" : "threads"}`,
    dms && `${dms} ${dms === 1 ? "DM" : "DMs"}`,
  ].filter(Boolean);
  const loading =
    list.status === "idle" ||
    list.status === "loading" ||
    inbox.status === "loading";
  return loading
    ? "Checking recent activity…"
    : unread.length
      ? [`${unread.length} unread`, ...kinds].join(" · ")
      : inbox.status === "ready"
        ? "Nothing unread"
        : undefined;
}
