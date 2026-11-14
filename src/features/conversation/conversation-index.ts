/**
 * One index of a session's conversations for every list and count that shows
 * them. It holds a record per conversation, replaced only when that
 * conversation's own evidence changes, and answers views (a filter, an order)
 * from those records. Lists subscribe to a view's keys and rows to their own
 * record, so a message re-renders the row it belongs to and nothing else.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { InboxItem } from "../relay/inbox";
import type { LatestMessage } from "../relay/channel-previews";
import type { ThreadActivityItem } from "../relay/unread";
import { channelUnread } from "../../bundled/channels/UnreadBadge";

/** Conversation kind determines artwork and the recency evidence to use. */
export type ConversationKind = "solo" | "team" | "dm";
export const conversationKind = (
  channel: ChannelSummary,
): ConversationKind | undefined =>
  channel.channelType === "solo"
    ? "solo"
    : channel.channelType === "dm"
      ? "dm"
      : channel.channelType === "stream" ||
          channel.channelType === "forum" ||
          channel.channelType === undefined
        ? "team"
        : undefined;

export type ConversationRecord = Readonly<{
  channel: ChannelSummary;
  kind: ConversationKind;
  /** Newest top-level message, from a fetched preview or live evidence. */
  latest: LatestMessage | undefined;
  /** Team: the newest thread you're in, at its latest reply. */
  thread: ThreadActivityItem | undefined;
  /**
   * Channels rank by what is relevant to you: top-level messages, threads you
   * are in, and your mentions and replies. Other people's thread chatter does
   * not move a channel. Solo chats and DMs rank by any message.
   */
  at: number;
  /** The channel or one of its threads is unread; a muted channel is quiet. */
  unread: boolean;
  /** An agent is on it: a working turn, or typing that isn't yours. */
  working: boolean;
}>;

/** A thread or a mention: a message, opened where it lives. */
export type ConversationEvent = Readonly<{
  key: string;
  channelId: string;
  rootId?: string | undefined;
  messageId: string;
  authorId: string;
  preview: string;
  createdAt: number;
  unread: boolean;
}>;

export type ConversationFilter =
  | "all"
  | "threads"
  | "dms"
  | "mentions"
  | "channels"
  | "working"
  | "waiting"
  | "reactions";

/**
 * What a list shows. A view is cached by this object: keep one while its
 * answer should hold, and pass a new one when a function here would answer
 * differently.
 */
export type ConversationQuery = Readonly<{
  filter: ConversationFilter;
  unread: boolean;
  sort?: "recent" | "alpha" | undefined;
  include?: ((channel: ChannelSummary) => boolean) | undefined;
  includeAuthor?: ((authorId: string) => boolean) | undefined;
  /** A conversation Unread keeps while it is open. */
  keep?: ((channelId: string) => boolean) | undefined;
  /** Names for A–Z and ties; a channel's own name otherwise. */
  label?: ((channel: ChannelSummary) => string) | undefined;
}>;

export type ConversationIndex = Readonly<{
  subscribe(listener: () => void): () => void;
  /** Row keys in order: `c:` a conversation's id, `e:` an event's key. */
  view(query: ConversationQuery): readonly string[];
  record(channelId: string): ConversationRecord | undefined;
  event(key: string): ConversationEvent | undefined;
}>;

const indexes = new WeakMap<RelaySession, ConversationIndex>();
export function conversationIndex(session: RelaySession) {
  let index = indexes.get(session);
  if (!index) {
    index = createConversationIndex(session);
    indexes.set(session, index);
  }
  return index;
}

const none: readonly string[] = Object.freeze([]);
const rootOf = (item: InboxItem) =>
  item.rootId ?? (item.thread ? item.messageId : undefined);
const itemUnread = (item: InboxItem) => item.unreadCount > 0 || item.manual;

function createConversationIndex(session: RelaySession): ConversationIndex {
  const listeners = new Set<() => void>();
  const records = new Map<string, ConversationRecord>();
  /** Evidence subscriptions of each listed conversation, while observed. */
  const watching = new Map<string, () => void>();
  const views = new WeakMap<
    ConversationQuery,
    { revision: number; keys: readonly string[] }
  >();
  let started = false;
  let observed = false;
  let ensured = false;
  let revision = 0;
  let pending = false;
  let inboxAt = new Map<string, number>();
  let muted: ReadonlySet<string> = new Set();
  let working: ReadonlySet<string> = new Set();
  let threads = new Map<string, ConversationEvent>();
  let mentions = new Map<string, ConversationEvent>();
  let eventsStale = true;

  const changed = () => {
    pending = true;
  };
  /** One notification for everything a source's change replaced. */
  const publish = () => {
    if (!pending) return;
    pending = false;
    revision++;
    for (const listener of [...listeners]) listener();
  };

  function describe(
    channel: ChannelSummary,
    kind: ConversationKind,
  ): ConversationRecord {
    const id = channel.id;
    const snapshot = session.unread.snapshot({
      kind: "channel",
      channelId: id,
    });
    const previews = session.channelPreviews.snapshot();
    const latest = previews.has(id)
      ? (previews.get(id) ?? undefined)
      : snapshot.latestTopLevel;
    const items = session.unread.activity(id).items ?? [];
    let thread: ThreadActivityItem | undefined;
    if (kind === "team")
      for (const item of items)
        if (!thread || item.createdAt > thread.createdAt) thread = item;
    return {
      channel,
      kind,
      latest,
      thread,
      at:
        kind === "team"
          ? Math.max(
              latest?.createdAt ?? 0,
              inboxAt.get(id) ?? 0,
              thread?.createdAt ?? 0,
            )
          : Math.max(
              latest?.createdAt ?? 0,
              channel.lastActivityAt ?? 0,
              snapshot.latestMessage?.createdAt ?? 0,
            ),
      unread:
        channelUnread(snapshot, kind === "dm", muted.has(id)) ||
        items.some((item) => item.unreadCount > 0),
      working: working.has(id),
    };
  }

  function refresh(channel: ChannelSummary, kind: ConversationKind) {
    const previous = records.get(channel.id);
    const next = describe(
      previous && sameFields(previous.channel, channel)
        ? previous.channel
        : channel,
      kind,
    );
    if (previous && sameFields(previous, next)) return;
    records.set(channel.id, next);
    changed();
  }
  const touch = (id: string) => {
    const record = records.get(id);
    if (record) refresh(record.channel, record.kind);
  };
  const touchAll = () => {
    for (const record of records.values()) refresh(record.channel, record.kind);
  };

  function readInbox() {
    const next = new Map<string, number>();
    for (const item of session.unread.inbox().items)
      next.set(
        item.channelId,
        Math.max(next.get(item.channelId) ?? 0, item.createdAt),
      );
    const previous = inboxAt;
    inboxAt = next;
    eventsStale = true;
    changed();
    for (const id of new Set([...previous.keys(), ...next.keys()]))
      if (previous.get(id) !== next.get(id)) touch(id);
  }
  function readMuted() {
    const preferences = session.sidebarPreferences.snapshot();
    const next = new Set(
      preferences.cached ? [] : (preferences.data?.muted ?? []),
    );
    const previous = muted;
    muted = next;
    for (const id of new Set([...previous, ...next]))
      if (previous.has(id) !== next.has(id)) touch(id);
  }
  function readWorking() {
    const next = new Set<string>();
    const activity = session.agentActivity.snapshot();
    for (const turn of activity.turns)
      if (turn.state === "working" && turn.channelId) next.add(turn.channelId);
    for (const entry of activity.typing) next.add(entry.channelId);
    for (const entry of session.typing.snapshot())
      if (entry.pubkey !== session.viewer) next.add(entry.channelId);
    const previous = working;
    working = next;
    for (const id of new Set([...previous, ...next]))
      if (previous.has(id) !== next.has(id)) touch(id);
  }
  function readChannels() {
    const list = session.channels.list();
    if (list.status !== "ready") ensured = false;
    else if (observed && !ensured) {
      ensured = true;
      void session.unread.ensure();
      void session.inboxFeed.ensure();
    }
    const present = new Set<string>();
    for (const channel of list.channels) {
      const kind = conversationKind(channel);
      if (
        !kind ||
        channel.archived ||
        channel.huddle ||
        channel.metadataPending
      )
        continue;
      present.add(channel.id);
      if (!watching.has(channel.id)) watch(channel.id);
      refresh(channel, kind);
    }
    for (const id of [...records.keys()])
      if (!present.has(id)) {
        records.delete(id);
        watching.get(id)?.();
        watching.delete(id);
        eventsStale = true;
        changed();
      }
  }
  function watch(id: string) {
    const stops = [
      session.unread.subscribe({ kind: "channel", channelId: id }, () => {
        touch(id);
        publish();
      }),
      session.unread.subscribeActivity(id, () => {
        eventsStale = true;
        changed();
        touch(id);
        publish();
      }),
    ];
    watching.set(id, () => {
      for (const end of stops) end();
    });
  }
  /**
   * Follows the session's evidence from first use for as long as the session
   * lives, so a read during render is as current as one after it.
   */
  function start() {
    if (started) return;
    started = true;
    const source = (read: () => void) => () => {
      read();
      publish();
    };
    session.channels.subscribeList(source(readChannels));
    session.unread.subscribeInbox(source(readInbox));
    session.channelPreviews.subscribe(source(touchAll));
    session.sidebarPreferences.subscribe(source(readMuted));
    session.agentActivity.subscribe(source(readWorking));
    session.typing.subscribe(source(readWorking));
    readMuted();
    readWorking();
    readInbox();
    readChannels();
    pending = false;
  }

  function readEvents() {
    if (!eventsStale) return;
    eventsStale = false;
    const byRoot = new Map<string, ConversationEvent>();
    const add = (event: ConversationEvent) => {
      const held = byRoot.get(event.key);
      if (!held || held.createdAt < event.createdAt)
        byRoot.set(event.key, {
          ...event,
          unread: event.unread || !!held?.unread,
        });
      else if (event.unread && !held.unread)
        byRoot.set(event.key, { ...held, unread: true });
    };
    const mentioned = new Map<string, ConversationEvent>();
    for (const record of records.values())
      if (record.kind === "team")
        for (const thread of session.unread.activity(record.channel.id).items ??
          [])
          add({
            key: `${record.channel.id}:${thread.rootId}`,
            channelId: record.channel.id,
            rootId: thread.rootId,
            messageId: thread.latestMessageId,
            authorId: thread.authorId,
            preview: thread.preview,
            createdAt: thread.createdAt,
            unread: thread.unreadCount > 0,
          });
    for (const item of session.unread.inbox().items) {
      const rootId = rootOf(item);
      if (rootId && records.get(item.channelId)?.kind === "team")
        add({
          key: `${item.channelId}:${rootId}`,
          channelId: item.channelId,
          rootId,
          messageId: item.messageId,
          authorId: item.authorId,
          preview: item.preview,
          createdAt: item.createdAt,
          unread: itemUnread(item),
        });
      const mention = item.mention;
      if (mention && records.get(mention.channelId)?.kind === "team")
        mentioned.set(mention.id, {
          key: mention.id,
          channelId: mention.channelId,
          rootId: rootOf(mention),
          messageId: mention.messageId,
          authorId: mention.authorId,
          preview: mention.preview,
          createdAt: mention.createdAt,
          unread: itemUnread(mention),
        });
    }
    threads = keepSame(threads, byRoot);
    mentions = keepSame(mentions, mentioned);
  }

  function build(query: ConversationQuery): readonly string[] {
    const { filter, include, includeAuthor, keep } = query;
    const alpha = query.sort === "alpha";
    if (filter === "reactions") return none;
    const name = query.label ?? ((channel: ChannelSummary) => channel.name);
    if (filter === "threads" || filter === "mentions") {
      readEvents();
      const shown = [...(filter === "threads" ? threads : mentions).values()]
        .flatMap((event) => {
          const channel = records.get(event.channelId)?.channel;
          return channel &&
            (!include || include(channel)) &&
            (!query.unread || event.unread) &&
            (!includeAuthor || includeAuthor(event.authorId))
            ? [{ event, name: alpha ? channel.name : "" }]
            : [];
        })
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            (alpha
              ? a.event.preview.localeCompare(b.event.preview)
              : b.event.createdAt - a.event.createdAt),
        );
      return shown.map(({ event }) => `e:${event.key}`);
    }
    const agents = filter === "working" || filter === "waiting";
    return [...records.values()]
      .filter(
        ({ channel, kind, latest, unread, working }) =>
          (!include || include(channel)) &&
          (filter !== "dms" || kind === "dm") &&
          (filter !== "channels" || kind === "team") &&
          (!agents || kind === "solo") &&
          (filter !== "working" || working) &&
          // Waiting: no agent is on it and the other side spoke last.
          (filter !== "waiting" ||
            (!working &&
              !!latest?.authorId &&
              latest.authorId !== session.viewer)) &&
          (!includeAuthor ||
            (!!latest?.authorId && includeAuthor(latest.authorId))) &&
          (!query.unread || unread || !!keep?.(channel.id)),
      )
      .map((record) => ({ record, name: name(record.channel) }))
      .sort(
        (a, b) =>
          (alpha ? 0 : b.record.at - a.record.at) ||
          a.name.localeCompare(b.name) ||
          a.record.channel.id.localeCompare(b.record.channel.id),
      )
      .map(({ record }) => `c:${record.channel.id}`);
  }

  return {
    subscribe(listener) {
      start();
      listeners.add(listener);
      // Asking for evidence belongs to an observer, not to a read in render.
      if (!observed) {
        observed = true;
        readChannels();
        publish();
      }
      return () => listeners.delete(listener);
    },
    view(query) {
      start();
      const cached = views.get(query);
      if (cached?.revision === revision) return cached.keys;
      const next = build(query);
      const keys =
        cached &&
        cached.keys.length === next.length &&
        cached.keys.every((key, at) => key === next[at])
          ? cached.keys
          : next;
      views.set(query, { revision, keys });
      return keys;
    },
    record(channelId) {
      start();
      return records.get(channelId);
    },
    event(key) {
      start();
      readEvents();
      return threads.get(key) ?? mentions.get(key);
    },
  };
}

function sameFields(a: object, b: object) {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    if (
      (a as Record<string, unknown>)[key] !==
      (b as Record<string, unknown>)[key]
    )
      return false;
  return true;
}

/** Events that did not change keep their identity for the rows showing them. */
function keepSame(
  previous: ReadonlyMap<string, ConversationEvent>,
  next: Map<string, ConversationEvent>,
) {
  for (const [key, event] of next) {
    const held = previous.get(key);
    if (held && sameFields(held, event)) next.set(key, held);
  }
  return next;
}

/** A view's row keys; the same array until its membership or order changes. */
export function useConversationKeys(
  session: RelaySession,
  query: ConversationQuery,
) {
  const index = conversationIndex(session);
  const get = useCallback(() => index.view(query), [index, query]);
  return useSyncExternalStore(index.subscribe, get, get);
}

/** How many rows a view holds. */
export function useConversationCount(
  session: RelaySession,
  query: ConversationQuery,
) {
  const index = conversationIndex(session);
  const get = useCallback(() => index.view(query).length, [index, query]);
  return useSyncExternalStore(index.subscribe, get, get);
}

export function useConversationRecord(session: RelaySession, id: string) {
  const index = conversationIndex(session);
  const get = useCallback(() => index.record(id), [index, id]);
  return useSyncExternalStore(index.subscribe, get, get);
}

export function useConversationEvent(session: RelaySession, key: string) {
  const index = conversationIndex(session);
  const get = useCallback(() => index.event(key), [index, key]);
  return useSyncExternalStore(index.subscribe, get, get);
}
