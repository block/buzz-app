/**
 * One index of a session's conversations for every list, card and count that
 * shows them. It holds a record per conversation, replaced only when that
 * conversation's own evidence changes, and keeps each view that is being
 * watched in order: a change moves the one row it belongs to. A row watches
 * its own record, so a message re-renders that row and nothing else.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { InboxItem } from "../relay/inbox";
import type { InboxReaction } from "../relay/inbox-reactions";
import type { LatestMessage } from "../relay/channel-heads";
import type { ThreadActivityItem } from "../relay/unread";
import { channelUnread } from "../../bundled/channels/UnreadBadge";
import { dmLabel } from "./dm-label";
import { reactionRows } from "./reaction-rows";

/** Conversation kind determines artwork and the recency evidence to use. */
type ConversationKind = "solo" | "team" | "dm";
const conversationKind = (
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
  /** What rows and A–Z call it: a DM by its people, the rest by name. */
  label: string;
  /** Newest top-level message, from the roster's heads and live traffic. */
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
 * What a list shows, as plain data: queries with equal fields are one view.
 * Team's All is a feed: its conversations with the threads, mentions and
 * reactions among them, each where its time puts it.
 */
export type ConversationQuery = Readonly<{
  filter: ConversationFilter;
  unread: boolean;
  sort?: "recent" | "alpha" | undefined;
  /** Team's conversations (channels and DMs) or Solo's; unset: every one. */
  home?: "team" | "solo" | undefined;
  /** Only these conversations: a section's own. */
  within?: ReadonlySet<string> | undefined;
  /** Only what people, or only what agents, sent. */
  sender?: "humans" | "agents" | undefined;
  /** A conversation Unread keeps while it is open. */
  keep?: string | undefined;
}>;

type ConversationIndex = Readonly<{
  /** Row keys in order: `c:` a conversation, `e:` an event, `r:` a reaction. */
  keys(query: ConversationQuery): readonly string[];
  /** Keeps the view in order and calls back when its rows or order change. */
  watch(query: ConversationQuery, listener: () => void): () => void;
  record(channelId: string): ConversationRecord | undefined;
  watchRecord(channelId: string, listener: () => void): () => void;
  event(key: string): ConversationEvent | undefined;
  reaction(
    key: string,
    sender?: ConversationQuery["sender"],
  ): InboxReaction | undefined;
  /** Events and reactions arrive whole; one subscription covers their rows. */
  watchEvents(listener: () => void): () => void;
  /** The view's name: equal for equal queries. */
  name(query: ConversationQuery): string;
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

type Row = Readonly<{ key: string; at: number; name: string }>;
type View = {
  query: ConversationQuery;
  rows: Row[];
  held: Map<string, Row>;
  keys: readonly string[] | undefined;
  /** Messages its event rows show: a channel's row does not repeat one. */
  shown: ReadonlySet<string>;
  listeners: Set<() => void>;
  /** The index revision its rows answer, while nothing is watching it. */
  revision: number;
};

const rootOf = (item: InboxItem) =>
  item.rootId ?? (item.thread ? item.messageId : undefined);
const itemUnread = (item: InboxItem) => item.unreadCount > 0 || item.manual;
const conversational = (filter: ConversationFilter) =>
  filter !== "threads" && filter !== "mentions" && filter !== "reactions";
/** Team's All interleaves events with its conversations. */
const feed = (query: ConversationQuery) =>
  query.filter === "all" && query.home === "team";
const none: ReadonlySet<string> = new Set();
const sets = new WeakMap<object, number>();
let setCount = 0;

function createConversationIndex(session: RelaySession): ConversationIndex {
  const records = new Map<string, ConversationRecord>();
  /** Evidence subscriptions of each listed conversation. */
  const watching = new Map<string, () => void>();
  const views = new Map<string, View>();
  const recordListeners = new Map<string, Set<() => void>>();
  const eventListeners = new Set<() => void>();
  let started = false;
  let observed = false;
  let ensured = false;
  let revision = 0;
  let inboxAt = new Map<string, number>();
  let muted: ReadonlySet<string> = new Set();
  let working: ReadonlySet<string> = new Set();
  /** A channel's threads you're in, from its own activity. */
  const channelThreads = new Map<string, readonly ConversationEvent[]>();
  let inboxThreads: readonly ConversationEvent[] = [];
  let threads: ReadonlyMap<string, ConversationEvent> = new Map();
  let mentions: ReadonlyMap<string, ConversationEvent> = new Map();
  let reactions: readonly InboxReaction[] = [];
  const reactionsBy = new Map<string, ReadonlyMap<string, InboxReaction>>();
  const senders = new Map<string, "agent" | "human" | "unknown">();
  /** Authors a sender filter could not judge, asked for once each. */
  const asked = new Set<string>();
  let asking: string[] | undefined;
  const ask = (authorId: string) => {
    if (asked.has(authorId)) return;
    asked.add(authorId);
    if (asking) {
      asking.push(authorId);
      return;
    }
    const ids = [authorId];
    asking = ids;
    queueMicrotask(() => {
      asking = undefined;
      void session.profiles.ensure(ids, "background").catch(() => {});
    });
  };
  let agents: ReadonlySet<string> = new Set();

  // What one source's change touched, announced together when it is done.
  const changedRecords = new Set<string>();
  const changedViews = new Set<View>();
  let changedEvents = false;
  const publish = () => {
    const rows = [...changedRecords];
    const lists = [...changedViews];
    const events = changedEvents;
    changedRecords.clear();
    changedViews.clear();
    changedEvents = false;
    for (const id of rows)
      for (const listener of [...(recordListeners.get(id) ?? [])]) listener();
    if (events) for (const listener of [...eventListeners]) listener();
    for (const view of lists)
      for (const listener of [...view.listeners]) listener();
  };

  const senderOf = (authorId: string) => {
    let kind = senders.get(authorId);
    if (kind) return kind;
    kind = "unknown";
    if (
      agents.has(authorId) ||
      session.profiles.snapshot().get(authorId)?.isAgent
    )
      kind = "agent";
    else {
      // A folded fallback is not evidence of a person: require a parsed profile.
      const event = session.profiles.event?.(authorId);
      try {
        const body: unknown = event && JSON.parse(event.content);
        if (body !== null && typeof body === "object" && !Array.isArray(body))
          kind = "human";
      } catch {
        // A malformed profile is unknown.
      }
      // A row the filter leaves out never mounts to ask for its own people.
      if (kind === "unknown") ask(authorId);
    }
    senders.set(authorId, kind);
    return kind;
  };
  const sent = (query: ConversationQuery, authorId: string | undefined) =>
    !query.sender ||
    (!!authorId &&
      senderOf(authorId) === (query.sender === "agents" ? "agent" : "human"));
  const placed = (query: ConversationQuery, record: ConversationRecord) =>
    (!query.within || query.within.has(record.channel.id)) &&
    (!query.home || (query.home === "solo") === (record.kind === "solo"));

  function labelOf(channel: ChannelSummary, kind: ConversationKind) {
    return kind === "dm"
      ? dmLabel(
          channel.participants,
          session.profiles.snapshot(),
          (key, fallback, candidates) =>
            session.names?.resolve(key, fallback, candidates) ?? fallback,
          channel.name || "Direct message",
        )
      : channel.name;
  }

  function describe(
    channel: ChannelSummary,
    kind: ConversationKind,
  ): ConversationRecord {
    const id = channel.id;
    const snapshot = session.unread.snapshot({
      kind: "channel",
      channelId: id,
    });
    const latest = session.channelHeads.latest(id);
    const items = session.unread.activity(id).items ?? [];
    let thread: ThreadActivityItem | undefined;
    if (kind === "team")
      for (const item of items)
        if (!thread || item.createdAt > thread.createdAt) thread = item;
    return {
      channel,
      kind,
      label: labelOf(channel, kind),
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
              // A chat nobody has written in yet ranks by when it was made.
              channel.lastActivityAt ?? channel.createdAt ?? 0,
              snapshot.latestMessage?.createdAt ?? 0,
            ),
      unread:
        channelUnread(snapshot, kind === "dm", muted.has(id)) ||
        items.some((item) => item.unreadCount > 0),
      working: working.has(id),
    };
  }

  /** The message a conversation's row shows: a newer thread reply, or its latest. */
  const shownMessage = (record: ConversationRecord) =>
    record.thread && record.thread.createdAt > (record.latest?.createdAt ?? 0)
      ? { id: record.thread.latestMessageId, authorId: record.thread.authorId }
      : record.latest;

  function conversationRow(view: View, record: ConversationRecord) {
    const { query } = view;
    const { filter } = query;
    const { kind, latest, working } = record;
    const shown = shownMessage(record);
    if (
      !placed(query, record) ||
      (filter === "dms" && kind !== "dm") ||
      (filter === "channels" && kind !== "team") ||
      ((filter === "working" || filter === "waiting") && kind !== "solo") ||
      (filter === "working" && !working) ||
      // Waiting: no agent is on it and the other side spoke last.
      (filter === "waiting" &&
        (working || !latest?.authorId || latest.authorId === session.viewer)) ||
      !sent(query, shown?.authorId) ||
      (query.unread && !record.unread && query.keep !== record.channel.id) ||
      (kind === "team" && !!shown?.id && view.shown.has(shown.id))
    )
      return;
    return {
      key: `c:${record.channel.id}`,
      at: record.at,
      name: record.label,
    };
  }

  const order = (query: ConversationQuery) =>
    query.sort === "alpha"
      ? (a: Row, b: Row) =>
          a.name.localeCompare(b.name) ||
          (a.key < b.key ? -1 : +(a.key > b.key))
      : (a: Row, b: Row) =>
          b.at - a.at ||
          a.name.localeCompare(b.name) ||
          (a.key < b.key ? -1 : +(a.key > b.key));
  /** Where a row is, or belongs: views order every row, so it is exact. */
  function position(view: View, row: Row) {
    const compare = order(view.query);
    let low = 0;
    let high = view.rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compare(view.rows[middle] as Row, row) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function build(view: View) {
    const { query } = view;
    const alpha = query.sort === "alpha";
    const rows: Row[] = [];
    const shown = new Set<string>();
    const events = (
      from: ReadonlyMap<string, ConversationEvent>,
      include: (event: ConversationEvent) => boolean,
    ) => {
      for (const event of from.values()) {
        const record = records.get(event.channelId);
        if (
          !record ||
          !placed(query, record) ||
          !include(event) ||
          (query.unread && !event.unread) ||
          !sent(query, event.authorId)
        )
          continue;
        shown.add(event.messageId);
        rows.push({
          key: `e:${event.key}`,
          at: event.createdAt,
          name: alpha ? `${record.channel.name}\n${event.preview}` : "",
        });
      }
    };
    const all = feed(query);
    if (query.filter === "threads" || all) events(threads, () => true);
    // A mention inside a thread, or one that started a thread, is that
    // thread's row in the feed.
    if (query.filter === "mentions" || all)
      events(
        mentions,
        (event) => !all || (!event.rootId && !threads.has(event.key)),
      );
    if (query.filter === "reactions" || (all && !query.unread))
      for (const item of reactionsOf(query.sender).values()) {
        const record = records.get(item.channelId);
        if (record && placed(query, record))
          rows.push({
            key: `r:${item.id}`,
            at: item.createdAt,
            name: alpha ? record.channel.name : "",
          });
      }
    view.shown = all ? shown : none;
    if (conversational(query.filter))
      for (const record of records.values()) {
        const row = conversationRow(view, record);
        if (row) rows.push(row);
      }
    rows.sort(order(query));
    const keys = rows.map((row) => row.key);
    const same =
      view.keys?.length === keys.length &&
      view.keys.every((key, at) => key === keys[at]);
    view.rows = rows;
    view.held = new Map(rows.map((row) => [row.key, row]));
    view.revision = revision;
    if (!same) {
      view.keys = keys;
      changedViews.add(view);
    }
  }

  /** Moves one conversation's row to where its record now puts it. */
  function place(
    view: View,
    record: ConversationRecord | undefined,
    id: string,
  ) {
    const key = `c:${id}`;
    const held = view.held.get(key);
    const row = record && conversationRow(view, record);
    if (!held && !row) return;
    const from = held ? position(view, held) : -1;
    if (held) {
      view.rows.splice(from, 1);
      view.held.delete(key);
    }
    let to = -1;
    if (row) {
      to = position(view, row);
      view.rows.splice(to, 0, row);
      view.held.set(key, row);
    }
    if (from === to) return;
    view.keys = undefined;
    changedViews.add(view);
  }

  function changed(id: string) {
    revision++;
    changedRecords.add(id);
    const record = records.get(id);
    for (const view of views.values())
      if (view.listeners.size && conversational(view.query.filter))
        place(view, record, id);
  }
  /** Rebuilds the watched views a change reaches that isn't one record's. */
  function rebuild(affects: (query: ConversationQuery) => boolean) {
    revision++;
    for (const view of views.values())
      if (view.listeners.size && affects(view.query)) build(view);
  }

  function refresh(channel: ChannelSummary, kind: ConversationKind) {
    const previous = records.get(channel.id);
    const next = describe(channel, kind);
    if (previous && sameFields(previous, next)) return;
    records.set(channel.id, next);
    changed(channel.id);
  }
  const touch = (id: string) => {
    const record = records.get(id);
    if (record) refresh(record.channel, record.kind);
  };

  function readInbox() {
    const items = session.unread.inbox().items;
    const next = new Map<string, number>();
    for (const item of items)
      next.set(
        item.channelId,
        Math.max(next.get(item.channelId) ?? 0, item.createdAt),
      );
    const previous = inboxAt;
    inboxAt = next;
    for (const id of new Set([...previous.keys(), ...next.keys()]))
      if (previous.get(id) !== next.get(id)) touch(id);
    readEvents(items);
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
  /** Names and faces arrive after the roster: DMs are labelled by them. */
  function readPeople() {
    senders.clear();
    for (const record of records.values())
      if (
        record.kind === "dm" &&
        labelOf(record.channel, record.kind) !== record.label
      )
        touch(record.channel.id);
    reactionsBy.clear();
    rebuild((query) => !!query.sender);
  }
  function readAgents() {
    agents = new Set(
      session.agentChoices.snapshot().identities.map((agent) => agent.pubkey),
    );
    senders.clear();
    reactionsBy.clear();
    rebuild((query) => !!query.sender);
  }
  function readReactions() {
    const next = session.inboxFeed.reactions.snapshot().items;
    if (next === reactions) return;
    reactions = next;
    reactionsBy.clear();
    changedEvents = true;
    rebuild((query) => query.filter === "reactions" || feed(query));
  }
  function reactionsOf(sender: ConversationQuery["sender"]) {
    const name = sender ?? "";
    let rows = reactionsBy.get(name);
    if (!rows) {
      rows = new Map(
        reactionRows(reactions, (authorId) =>
          sent({ ...all, sender }, authorId),
        )
          .filter((item) => records.has(item.channelId))
          .map((item) => [item.id, item]),
      );
      reactionsBy.set(name, rows);
    }
    return rows;
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
    let roster = false;
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
      // A message replaces only its own channel's summary in the list.
      if (records.get(channel.id)?.channel === channel) continue;
      if (!watching.has(channel.id)) {
        roster = true;
        watch(channel.id);
        readThreads(channel.id, kind);
      }
      refresh(channel, kind);
    }
    for (const id of [...records.keys()])
      if (!present.has(id)) {
        roster = true;
        records.delete(id);
        watching.get(id)?.();
        watching.delete(id);
        channelThreads.delete(id);
        changed(id);
      }
    // Events and reactions show only in listed conversations.
    if (roster) {
      reactionsBy.clear();
      mergeEvents();
      rebuild((query) => !conversational(query.filter) || feed(query));
    }
  }
  function watch(id: string) {
    const stops = [
      session.unread.subscribe({ kind: "channel", channelId: id }, () => {
        touch(id);
        publish();
      }),
      session.unread.subscribeActivity(id, () => {
        const record = records.get(id);
        if (record && readThreads(id, record.kind)) mergeEvents();
        touch(id);
        publish();
      }),
    ];
    watching.set(id, () => {
      for (const end of stops) end();
    });
  }

  /** One channel's threads; whether any of them changed. */
  function readThreads(id: string, kind: ConversationKind) {
    const previous = channelThreads.get(id) ?? [];
    const next =
      kind === "team"
        ? (session.unread.activity(id).items ?? []).map(
            (thread, at): ConversationEvent => {
              const event = {
                key: `${id}:${thread.rootId}`,
                channelId: id,
                rootId: thread.rootId,
                messageId: thread.latestMessageId,
                authorId: thread.authorId,
                preview: thread.preview,
                createdAt: thread.createdAt,
                unread: thread.unreadCount > 0,
              };
              const held = previous[at];
              return held && sameFields(held, event) ? held : event;
            },
          )
        : [];
    if (
      next.length === previous.length &&
      next.every((event, at) => event === previous[at])
    )
      return false;
    channelThreads.set(id, next);
    return true;
  }
  /** The inbox's threads and mentions, then the events both sources give. */
  function readEvents(items: readonly InboxItem[]) {
    const fromInbox: ConversationEvent[] = [];
    const mentioned = new Map<string, ConversationEvent>();
    for (const item of items) {
      const rootId = rootOf(item);
      if (rootId)
        fromInbox.push({
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
      if (mention)
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
    inboxThreads = fromInbox;
    mergeEvents(mentioned);
  }
  function mergeEvents(mentioned?: Map<string, ConversationEvent>) {
    const team = (event: ConversationEvent) =>
      records.get(event.channelId)?.kind === "team";
    const byRoot = new Map<string, ConversationEvent>();
    const add = (event: ConversationEvent) => {
      const held = byRoot.get(event.key);
      if (!held || held.createdAt < event.createdAt)
        byRoot.set(
          event.key,
          held?.unread && !event.unread ? { ...event, unread: true } : event,
        );
      else if (event.unread && !held.unread)
        byRoot.set(event.key, { ...held, unread: true });
    };
    for (const events of channelThreads.values()) events.forEach(add);
    for (const event of inboxThreads) if (team(event)) add(event);
    const nextThreads = keepSame(threads, byRoot);
    const nextMentions = mentioned
      ? keepSame(
          mentions,
          new Map([...mentioned].filter(([, event]) => team(event))),
        )
      : mentions;
    if (sameMap(threads, nextThreads) && sameMap(mentions, nextMentions))
      return;
    threads = nextThreads;
    mentions = nextMentions;
    changedEvents = true;
    rebuild(
      (query) =>
        query.filter === "threads" ||
        query.filter === "mentions" ||
        feed(query),
    );
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
    session.channelHeads.subscribe((ids) => {
      for (const id of ids ?? [...records.keys()]) touch(id);
      publish();
    });
    session.sidebarPreferences.subscribe(source(readMuted));
    session.agentActivity.subscribe(source(readWorking));
    session.typing.subscribe(source(readWorking));
    session.profiles.subscribe(source(readPeople));
    session.names?.subscribe(source(readPeople));
    session.agentChoices.subscribe(source(readAgents));
    session.inboxFeed.reactions.subscribe(source(readReactions));
    readAgents();
    readMuted();
    readWorking();
    readChannels();
    readInbox();
    readReactions();
    changedRecords.clear();
    changedViews.clear();
    changedEvents = false;
  }
  function observe() {
    if (observed) return;
    observed = true;
    // Asking for evidence belongs to an observer, not to a read in render.
    readChannels();
    publish();
  }

  const name = (query: ConversationQuery) => {
    let within = 0;
    if (query.within) {
      within = sets.get(query.within) ?? ++setCount;
      sets.set(query.within, within);
    }
    return [
      query.filter,
      query.unread ? 1 : 0,
      query.sort === "alpha" ? "a" : "r",
      query.home ?? "",
      within,
      query.sender ?? "",
      query.keep ?? "",
    ].join("|");
  };
  function viewOf(query: ConversationQuery) {
    start();
    const key = name(query);
    let view = views.get(key);
    if (!view) {
      // Views nothing watches are answers to one render; keep only a few.
      if (views.size > 64)
        for (const [held, other] of views)
          if (!other.listeners.size) views.delete(held);
      view = {
        query,
        rows: [],
        held: new Map(),
        keys: undefined,
        shown: none,
        listeners: new Set(),
        revision: -1,
      };
      views.set(key, view);
    }
    if (!view.listeners.size && view.revision !== revision) {
      build(view);
      changedViews.delete(view);
    }
    return view;
  }

  return {
    name,
    keys(query) {
      const view = viewOf(query);
      view.keys ??= view.rows.map((row) => row.key);
      return view.keys;
    },
    watch(query, listener) {
      const view = viewOf(query);
      view.listeners.add(listener);
      observe();
      if (query.filter === "reactions" || feed(query))
        void session.inboxFeed.reactions.ensure();
      return () => {
        view.listeners.delete(listener);
        view.revision = revision;
      };
    },
    record(channelId) {
      start();
      return records.get(channelId);
    },
    watchRecord(channelId, listener) {
      start();
      const listeners = recordListeners.get(channelId) ?? new Set();
      recordListeners.set(channelId, listeners);
      listeners.add(listener);
      observe();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) recordListeners.delete(channelId);
      };
    },
    event(key) {
      start();
      return threads.get(key) ?? mentions.get(key);
    },
    reaction(key, sender) {
      start();
      return reactionsOf(sender).get(key);
    },
    watchEvents(listener) {
      start();
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
}

const all: ConversationQuery = { filter: "all", unread: false };

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
function sameMap<Value>(
  a: ReadonlyMap<string, Value>,
  b: ReadonlyMap<string, Value>,
) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of b) if (a.get(key) !== value) return false;
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
  const name = index.name(query);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Equal queries share a name; the first one read stands for them.
  const subscribe = useCallback(
    (listener: () => void) => index.watch(query, listener),
    [index, name],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: As above.
  const get = useCallback(() => index.keys(query), [index, name]);
  return useSyncExternalStore(subscribe, get, get);
}

/** How many rows a view holds. */
export function useConversationCount(
  session: RelaySession,
  query: ConversationQuery,
) {
  const index = conversationIndex(session);
  const name = index.name(query);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Equal queries share a name; the first one read stands for them.
  const subscribe = useCallback(
    (listener: () => void) => index.watch(query, listener),
    [index, name],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: As above.
  const get = useCallback(() => index.keys(query).length, [index, name]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useConversationRecord(session: RelaySession, id: string) {
  const index = conversationIndex(session);
  const subscribe = useCallback(
    (listener: () => void) => index.watchRecord(id, listener),
    [index, id],
  );
  const get = useCallback(() => index.record(id), [index, id]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useConversationEvent(session: RelaySession, key: string) {
  const index = conversationIndex(session);
  const get = useCallback(() => index.event(key), [index, key]);
  return useSyncExternalStore(index.watchEvents, get, get);
}

export function useConversationReaction(
  session: RelaySession,
  key: string,
  sender?: ConversationQuery["sender"],
) {
  const index = conversationIndex(session);
  const get = useCallback(
    () => index.reaction(key, sender),
    [index, key, sender],
  );
  return useSyncExternalStore(index.watchEvents, get, get);
}
