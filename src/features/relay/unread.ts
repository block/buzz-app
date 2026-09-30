import type { ChannelQueries, ChannelMessage } from "./contracts";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import { threadReference } from "./thread-reference";
import { createSidebarState, contextKey } from "./sidebar-state";
import {
  browserSidebarStorage,
  unreadTargetKey,
  type UnreadTarget,
  type ReadMutationResult,
  type SidebarStorage,
  type AnchoredRead,
} from "./sidebar-journal";
import {
  MAX_MESSAGE_READS,
  type SidebarApi,
  type ReadCount,
  type ReadTarget,
} from "./sidebar-api";
export type { UnreadTarget, ReadMutationResult } from "./sidebar-journal";
export type ReadSyncSnapshot = Readonly<{
  capability: "unsupported" | "frontier-sync";
  status: "loading" | "local" | "pending" | "reconciled" | "stale" | "error";
  completeness: "unknown" | "snapshot";
  error?: string | undefined;
}>;
export type UnreadSnapshot = Readonly<{
  target: UnreadTarget;
  latestMessage?: Readonly<{ id: string; createdAt: number }>;
  unread: ReadCount;
  attention: ReadCount;
  freshness: "unknown" | "observed" | "stale";
  manual: "none" | "local-only";
  error?: string | undefined;
}>;
export type MessageAttention = Readonly<{
  status: "unknown" | "ineligible" | "eligible";
  category?: "mention" | "direct" | "thread";
  mentioned?: boolean;
  rootId?: string;
  forced: boolean;
  unread: boolean;
  viewing: boolean;
}>;
export type ThreadActivityItem = Readonly<{
  channelId: string;
  rootId: string;
  latestMessageId: string;
  authorId: string;
  createdAt: number;
  preview: string;
  unread: ReadCount;
}>;
export type ThreadActivitySnapshot = Readonly<{
  channelId: string;
  items: readonly ThreadActivityItem[] | null;
  complete: boolean;
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
export type ReadingHandle = Readonly<{
  view(messageIds: readonly string[], visible: () => boolean): void;
  observe(messageIds: readonly string[]): Promise<void>;
  dispose(): void;
}>;
export interface UnreadCapability {
  snapshot(target: UnreadTarget): UnreadSnapshot;
  attention(channelId: string, messageId: string): MessageAttention;
  subscribe(target: UnreadTarget, listener: () => void): () => void;
  subscribeMessages(
    channelId: string,
    messageIds: readonly string[],
    listener: () => void,
  ): () => void;
  activity(channelId: string): ThreadActivitySnapshot;
  subscribeActivity(channelId: string, listener: () => void): () => void;
  loadActivity(channelId: string): Promise<void>;
  sync(): ReadSyncSnapshot;
  subscribeSync(listener: () => void): () => void;
  ensure(): Promise<void>;
  refresh(): Promise<void>;
  retrySync(): Promise<void>;
  reading(channelId: string): ReadingHandle;
  markThrough(
    target: UnreadTarget,
    messageId: string,
  ): Promise<ReadMutationResult>;
  markMessageUnread(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  markMessageRead(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  leaveChannel(channelId: string): void;
  enterChannel(channelId: string): Promise<void>;
  clearUnreadLocal(target: UnreadTarget): Promise<ReadMutationResult>;
  markChannelRead(channelId: string): Promise<ReadMutationResult>;
  markUnreadLocal(target: UnreadTarget): Promise<ReadMutationResult>;
  readonly syncedManualUnread: false;
}
export const hasUnread = (count: ReadCount) =>
  count.status !== "unknown" && count.value > 0;
export const unreadLabel = (count: ReadCount) =>
  count.status === "unknown"
    ? "Unread unknown"
    : `${count.status === "at_least" ? "At least " : ""}${count.value} unread messages`;
const unknown: ReadCount = Object.freeze({ status: "unknown" });
const sameCount = (a: ReadCount, b: ReadCount) =>
  a.status === b.status &&
  (a.status === "unknown" || (b.status !== "unknown" && a.value === b.value));
const zero: ReadCount = Object.freeze({ status: "exact", value: 0 });
const channelOf = (event: RelayEvent | undefined) =>
  event?.tags.find(([name]) => name === "h")?.[1];
const wireTarget = (target: UnreadTarget): ReadTarget => ({
  channel_id: target.channelId,
  ...(target.kind === "thread" ? { root_id: target.rootId } : {}),
});

/** Presentation and observed-anchor adapter over the one relay-backed authority. */
export function createUnread({
  api,
  storage,
  scope,
  channels,
  reader,
  viewer,
  find,
  loaded = (id) => channels.window(id).rows,
  notify = (listener) => listener(),
}: {
  api: SidebarApi | undefined;
  storage?: SidebarStorage | undefined;
  scope: string;
  channels: ChannelQueries;
  reader: RelayReader;
  viewer: string;
  find: (id: string) => RelayEvent | undefined;
  loaded?: (channelId: string) => readonly ChannelMessage[];
  notify?: (listener: () => void) => void;
}) {
  let closed = false,
    epoch = 0;
  const allowed = (id: string) =>
    !closed &&
    channels
      .list()
      .channels.some(
        (c) => c.id === id && !c.cached && c.members?.includes(viewer),
      );
  const state = createSidebarState({
    api,
    storage: storage ?? browserSidebarStorage(scope),
    allowed,
    notify,
  });
  const snapshots = new Map<string, UnreadSnapshot>(),
    activities = new Map<string, ThreadActivitySnapshot>();
  const previews = new Map<string, RelayEvent>();
  const listeners = new Set<() => void>();
  const views = new Map<
    () => void,
    { ids: Set<string>; visible: () => boolean }
  >();
  const handles = new Set<() => void>();
  const manualRevision = new Map<string, number>();
  const forcedMessages = new Map<string, Set<string>>();
  const entered = new Set<string>();
  const visits = new Map<string, number>();
  const mutations = new Map<string, Promise<unknown>>();
  const messageForce = (channelId: string) => ({
    kind: "message-force" as const,
    channelId,
  });
  function serialize<T>(
    channelId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = (mutations.get(channelId) ?? Promise.resolve()).then(
      operation,
      operation,
    );
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    mutations.set(channelId, settled);
    void settled.then(() => {
      if (mutations.get(channelId) === settled) mutations.delete(channelId);
    });
    return next;
  }
  function messageSubtree(channelId: string, messageId: string) {
    if (!allowed(channelId)) throw new Error("Read target unavailable");
    const rows = [
      ...new Map(loaded(channelId).map((row) => [row.id, row])).values(),
    ];
    const selected = rows.find((row) => row.id === messageId);
    if (!selected) throw new Error("Load a verified message before marking it");
    const ids = new Set([messageId]);
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.replyParentId) continue;
      const siblings = children.get(row.replyParentId) ?? [];
      siblings.push(row.id);
      children.set(row.replyParentId, siblings);
    }
    for (const id of ids)
      for (const child of children.get(id) ?? []) ids.add(child);
    if (ids.size > MAX_MESSAGE_READS)
      throw new Error("Loaded reply subtree exceeds the read action limit");
    const captured = rows
      .filter((row) => ids.has(row.id))
      .map((row) => {
        const raw = event(row.id);
        if (
          !raw ||
          row.channelId !== channelId ||
          row.authorId !== raw.pubkey ||
          row.membership ||
          (row.delivery && !["accepted", "seen"].includes(row.delivery)) ||
          channelOf(raw) !== channelId ||
          ![9, 40002, 45001, 45003].includes(raw.kind)
        )
          throw new Error("Read target unavailable");
        return { row, raw };
      });
    const generation = epoch,
      visit = visits.get(channelId) ?? 0;
    const valid = () => {
      if (
        closed ||
        generation !== epoch ||
        !allowed(channelId) ||
        (visits.get(channelId) ?? 0) !== visit
      )
        return false;
      const current = new Map(loaded(channelId).map((row) => [row.id, row]));
      return captured.every(({ row, raw }) => {
        const now = current.get(row.id);
        return (
          event(row.id) === raw &&
          now?.channelId === channelId &&
          now.authorId === raw.pubkey &&
          (!now.delivery || ["accepted", "seen"].includes(now.delivery)) &&
          !now.membership &&
          now.content === row.content &&
          now.sourceContent === row.sourceContent &&
          now.replyParentId === row.replyParentId &&
          now.threadRootId === row.threadRootId
        );
      });
    };
    return { captured, valid };
  }
  const lifetime = new AbortController();
  const event = (id: string) => {
    const value = find(id) ?? previews.get(id);
    return value && allowed(channelOf(value) ?? "") ? value : undefined;
  };
  function context(message: RelayEvent): ReadTarget | undefined {
    const channelId = channelOf(message);
    if (!channelId || !allowed(channelId)) return;
    let current = message;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(current.id)) return;
      visited.add(current.id);
      const ref = threadReference(current);
      if (!ref)
        return {
          channel_id: channelId,
          ...(current.id !== message.id ? { root_id: current.id } : {}),
        };
      const next = event(ref.rootId);
      if (!next) return { channel_id: channelId, root_id: ref.rootId };
      if (channelOf(next) !== channelId) return;
      current = next;
    }
  }
  function sync(): ReadSyncSnapshot {
    const value = state.sync();
    return Object.freeze({
      capability: api ? "frontier-sync" : "unsupported",
      status:
        value.status === "unsupported"
          ? "local"
          : value.status === "idle" || value.status === "loading"
            ? "loading"
            : value.status === "ready"
              ? value.pending
                ? "pending"
                : "reconciled"
              : value.status,
      completeness: value.status === "ready" ? "snapshot" : "unknown",
      error: value.error,
    });
  }
  let syncSnapshot = sync();
  function publish() {
    activities.clear();
    syncSnapshot = sync();
    for (const listener of listeners) notify(listener);
  }
  const stop = state.subscribe(publish);
  let ensureRequested = false;
  // Only access changes require a traversal. Metadata and timeline previews
  // also publish the roster, but neither changes which relay rows we admit.
  const rosterKey = () => {
    const list = channels.list();
    return JSON.stringify([
      list.status,
      list.channels
        .map((c) => [c.id, !!c.cached, c.members?.includes(viewer) ?? false])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]);
  };
  let previousRosterKey = rosterKey();
  const stopRoster = channels.subscribeList(() => {
    const key = rosterKey();
    if (key === previousRosterKey) return;
    previousRosterKey = key;
    publish();
    if (ensureRequested && channels.list().status === "ready")
      void state.ensure(true);
  });
  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function freshness() {
    return state.sync().status === "ready"
      ? ("observed" as const)
      : state.sync().status === "idle" || state.sync().status === "unsupported"
        ? ("unknown" as const)
        : ("stale" as const);
  }
  function snapshot(target: UnreadTarget): UnreadSnapshot {
    const key = unreadTargetKey(target),
      cached = snapshots.get(key);
    const row = state.row(target.channelId);
    let unread = unknown,
      attention = unknown;
    let latestMessage: UnreadSnapshot["latestMessage"];
    if (row && target.kind === "channel") {
      unread = row.unread;
      attention = row.attention;
      if (row.latest_message_id && row.latest_message_at !== null)
        latestMessage = {
          id: row.latest_message_id,
          createdAt: row.latest_message_at,
        };
    } else if (row && target.kind === "thread") {
      const thread = row.threads.items.find((t) => t.root_id === target.rootId);
      unread = thread?.unread ?? (row.threads.complete ? zero : unknown);
      attention = thread?.attention ?? (row.threads.complete ? zero : unknown);
      if (thread)
        latestMessage = {
          id: thread.latest_reply_id,
          createdAt: thread.latest_reply_at,
        };
    } else if (target.kind === "message") {
      const message = event(target.messageId),
        resolved = message && context(message);
      const result = resolved && state.context(resolved);
      const status =
        result?.status === "available"
          ? result.messages.find((m) => m.message_id === target.messageId)
          : undefined;
      if (status?.status === "unread") {
        unread = { status: "exact", value: 1 };
        attention =
          status.attention === null
            ? unknown
            : { status: "exact", value: status.attention ? 1 : 0 };
      } else if (status?.status === "read" || status?.status === "not_counted")
        unread = attention = zero;
    }
    const result: UnreadSnapshot = Object.freeze({
      target,
      unread,
      attention,
      ...(latestMessage ? { latestMessage } : {}),
      freshness: freshness(),
      manual:
        allowed(target.channelId) &&
        (state.journal.manual(target) ||
          (target.kind === "channel" &&
            state.journal.manual(messageForce(target.channelId))) ||
          (target.kind === "message" &&
            forcedMessages.get(target.channelId)?.has(target.messageId)))
          ? "local-only"
          : "none",
      error: state.operationError(target.channelId) ?? state.sync().error,
    });
    if (
      cached &&
      cached.freshness === result.freshness &&
      cached.manual === result.manual &&
      cached.error === result.error &&
      sameCount(cached.unread, result.unread) &&
      sameCount(cached.attention, result.attention) &&
      cached.latestMessage?.id === result.latestMessage?.id &&
      cached.latestMessage?.createdAt === result.latestMessage?.createdAt
    )
      return cached;
    if (snapshots.size >= 4096)
      snapshots.delete(snapshots.keys().next().value ?? "");
    snapshots.set(key, result);
    return result;
  }
  function attention(channelId: string, messageId: string): MessageAttention {
    const message = event(messageId),
      target = message && context(message);
    const viewing = [...views.values()].some(
      (view) => view.ids.has(messageId) && view.visible(),
    );
    if (!message || !target || target.channel_id !== channelId)
      return { status: "unknown", unread: false, forced: false, viewing };
    const result = state.context(target);
    const status =
      result?.status === "available"
        ? result.messages.find((m) => m.message_id === messageId)
        : undefined;
    const mentioned = message.tags.some(
      ([name, value]) => name === "p" && value?.toLowerCase() === viewer,
    );
    const category =
      channels.list().channels.find((c) => c.id === channelId)?.channelType ===
      "dm"
        ? "direct"
        : mentioned ||
            message.tags.some(
              ([name, value]) => name === "broadcast" && value === "1",
            )
          ? "mention"
          : target.root_id
            ? "thread"
            : undefined;
    const forced = forcedMessages.get(channelId)?.has(messageId) ?? false;
    return {
      status:
        status?.status === "unread"
          ? status.attention === null
            ? "unknown"
            : status.attention
              ? "eligible"
              : "ineligible"
          : status?.status === "read" || status?.status === "not_counted"
            ? "ineligible"
            : "unknown",
      ...(category ? { category } : {}),
      ...(target.root_id ? { rootId: target.root_id } : {}),
      ...(mentioned ? { mentioned: true } : {}),
      forced,
      unread:
        message.pubkey !== viewer &&
        (status?.status === "unread" ||
          forced ||
          state.journal.manual({ kind: "message", channelId, messageId })),
      viewing,
    };
  }
  function activity(channelId: string): ThreadActivitySnapshot {
    const cached = activities.get(channelId);
    if (cached) return cached;
    const row = state.row(channelId);
    const result: ThreadActivitySnapshot = Object.freeze({
      channelId,
      complete: row?.threads.complete ?? false,
      freshness: freshness(),
      error: state.operationError(channelId) ?? state.sync().error,
      items: row
        ? row.threads.items
            .filter(
              (t) => t.attention.status === "unknown" || hasUnread(t.attention),
            )
            .map((t) => {
              const preview = event(t.latest_reply_id);
              return {
                channelId,
                rootId: t.root_id,
                latestMessageId: t.latest_reply_id,
                authorId: preview?.pubkey ?? "",
                createdAt: t.latest_reply_at,
                preview: preview?.content ?? "Open thread to read",
                unread: t.unread,
              };
            })
        : null,
    });
    if (activities.size >= 1000)
      activities.delete(activities.keys().next().value ?? "");
    activities.set(channelId, result);
    return result;
  }
  const capability: UnreadCapability = Object.freeze<UnreadCapability>({
    snapshot,
    attention,
    activity,
    subscribe(target, listener) {
      const message =
        target.kind === "message" ? event(target.messageId) : undefined;
      const resolved = message && context(message);
      const lease =
        resolved && message
          ? state.retain({ target: resolved, message_ids: [message.id] })
          : undefined;
      const off = subscribe(listener);
      return () => {
        off();
        lease?.dispose();
      };
    },
    subscribeMessages(channelId, messageIds, listener) {
      const queries = new Map<
        string,
        { target: ReadTarget; message_ids: string[] }
      >();
      for (const id of new Set(messageIds)) {
        const message = event(id),
          resolved = message && context(message);
        if (!resolved || resolved.channel_id !== channelId) continue;
        const key = contextKey(resolved);
        const query = queries.get(key) ?? { target: resolved, message_ids: [] };
        query.message_ids.push(id);
        queries.set(key, query);
      }
      const leases: ReturnType<typeof state.retain>[] = [];
      try {
        for (const query of queries.values())
          leases.push(state.retain(query, true));
      } catch (error) {
        for (const lease of leases) lease.dispose();
        throw error;
      }
      const off = subscribe(listener);
      return () => {
        off();
        for (const lease of leases) lease.dispose();
      };
    },
    subscribeActivity: (_channelId, listener) => subscribe(listener),
    async loadActivity(channelId) {
      const items = activity(channelId).items;
      if (!items?.length || !allowed(channelId)) return;
      const generation = epoch;
      const found = await reader.read(
        [{ ids: items.map((t) => t.latestMessageId), limit: 5 }],
        { signal: lifetime.signal, priority: "background" },
      );
      if (closed || epoch !== generation || !allowed(channelId)) return;
      const ids = new Set(items.map((t) => t.latestMessageId));
      for (const message of found)
        if (ids.has(message.id) && channelOf(message) === channelId) {
          if (previews.size >= 100)
            previews.delete(previews.keys().next().value ?? "");
          previews.set(message.id, message);
        }
      publish();
    },
    sync: () => syncSnapshot,
    subscribeSync: subscribe,
    ensure: () => {
      ensureRequested = true;
      return channels.list().status === "ready"
        ? state.ensure()
        : Promise.resolve();
    },
    refresh: state.refresh,
    retrySync: state.retry,
    syncedManualUnread: false,
    reading(channelId) {
      if (!allowed(channelId) || handles.size >= 64)
        throw new Error("Reading handle unavailable");
      let active = true;
      const generation = epoch,
        manual = manualRevision.get(channelId) ?? 0;
      const observed = new Set<string>();
      const valid = () =>
        active &&
        !closed &&
        epoch === generation &&
        allowed(channelId) &&
        (manualRevision.get(channelId) ?? 0) === manual;
      const dispose = () => {
        active = false;
        handles.delete(dispose);
        views.delete(dispose);
      };
      handles.add(dispose);
      return {
        dispose,
        view(ids, visible) {
          if (valid() && ids.length <= 128)
            views.set(dispose, {
              ids: new Set(
                ids.filter(
                  (id) => channelOf(event(id) as RelayEvent) === channelId,
                ),
              ),
              visible: () => valid() && visible(),
            });
        },
        async observe(ids) {
          if (!valid() || ids.length > 128) return;
          const newest = new Map<
            string,
            { target: ReadTarget; event: RelayEvent }
          >();
          for (const id of ids) {
            if (observed.has(id)) continue;
            const message = event(id),
              target = message && context(message);
            if (
              !message ||
              !target ||
              target.channel_id !== channelId ||
              ![9, 40002, 45001, 45003].includes(message.kind)
            )
              continue;
            const key = contextKey(target),
              previous = newest.get(key);
            if (!previous || message.created_at > previous.event.created_at)
              newest.set(key, { target, event: message });
          }
          const intents: AnchoredRead[] = [...newest.values()].map(
            ({ target, event }) => ({
              intent: { type: "mark_through", target, message_id: event.id },
              createdAt: event.created_at,
            }),
          );
          if (intents.length) await state.enqueue(intents, () => false, valid);
          for (const id of ids) observed.add(id);
        },
      };
    },
    async markThrough(target, messageId) {
      const generation = epoch,
        message = event(messageId),
        resolved = message && context(message);
      const expected =
        target.kind === "message" ? resolved : wireTarget(target);
      if (
        !message ||
        !resolved ||
        !expected ||
        contextKey(resolved) !== contextKey(expected)
      )
        throw new Error("Message does not belong to the read target");
      return serialize(target.channelId, () =>
        state.enqueue(
          [
            {
              intent: {
                type: "mark_through",
                target: expected,
                message_id: messageId,
              },
              createdAt: message.created_at,
            },
          ],
          (t) => unreadTargetKey(t) === unreadTargetKey(target),
          () => !closed && epoch === generation && allowed(target.channelId),
        ),
      );
    },
    async markMessageUnread(channelId, messageId) {
      const { captured, valid } = messageSubtree(channelId, messageId);
      manualRevision.set(channelId, (manualRevision.get(channelId) ?? 0) + 1);
      return serialize(channelId, async () => {
        const result = await state.journal.markUnread(
          messageForce(channelId),
          valid,
        );
        if (valid()) {
          const forced = forcedMessages.get(channelId) ?? new Set<string>();
          for (const { row } of captured) forced.add(row.id);
          forcedMessages.set(channelId, forced);
          publish();
        }
        return result;
      });
    },
    async markMessageRead(channelId, messageId) {
      const { captured, valid } = messageSubtree(channelId, messageId);
      const foreign = captured.filter(({ raw }) => raw.pubkey !== viewer);
      // Unsupported hosts may remove only a local force on already proven reads.
      if (
        !api &&
        foreign.some(({ row, raw }) => {
          const target = context(raw),
            evidence = target && state.context(target);
          return (
            evidence?.status !== "available" ||
            !evidence.messages.some(
              (m) =>
                m.message_id === row.id &&
                (m.status === "read" || m.status === "not_counted"),
            )
          );
        })
      )
        throw new Error("Sidebar API unsupported");
      return serialize(channelId, async () => {
        const ids = new Set(captured.map(({ row }) => row.id));
        const forced = forcedMessages.get(channelId);
        const remaining = forced && [...forced].some((id) => !ids.has(id));
        const intents: AnchoredRead[] =
          foreign.length && api
            ? [
                {
                  intent: {
                    type: "mark_messages_read",
                    channel_id: channelId,
                    message_ids: foreign.map(({ row }) => row.id),
                  },
                  createdAt: Math.max(
                    ...foreign.map(({ raw }) => raw.created_at),
                  ),
                },
              ]
            : [];
        const clear = (t: import("./sidebar-journal").SidebarManualTarget) =>
          t.channelId === channelId &&
          ((t.kind === "message-force" && !remaining) ||
            (t.kind === "message" && ids.has(t.messageId)));
        const result = intents.length
          ? await state.enqueue(intents, clear, valid)
          : await state.journal.enqueue([], clear, valid);
        if (valid()) {
          for (const id of ids) forced?.delete(id);
          if (!forced?.size) forcedMessages.delete(channelId);
          publish();
        }
        return result;
      });
    },
    leaveChannel(channelId) {
      visits.set(channelId, (visits.get(channelId) ?? 0) + 1);
      entered.delete(channelId);
      if (forcedMessages.delete(channelId)) publish();
    },
    enterChannel(channelId) {
      const visit = visits.get(channelId) ?? 0,
        generation = epoch;
      return serialize(channelId, async () => {
        if (entered.has(channelId)) return;
        const valid = () =>
          !closed &&
          generation === epoch &&
          allowed(channelId) &&
          (visits.get(channelId) ?? 0) === visit;
        await state.journal.enqueue(
          [],
          (t) => t.kind === "message-force" && t.channelId === channelId,
          valid,
        );
        if (valid()) entered.add(channelId);
      });
    },
    async clearUnreadLocal(target) {
      const generation = epoch;
      if (!allowed(target.channelId))
        throw new Error("Read target unavailable");
      return serialize(target.channelId, () =>
        state.journal.enqueue(
          [],
          (t) => unreadTargetKey(t) === unreadTargetKey(target),
          () => !closed && generation === epoch && allowed(target.channelId),
        ),
      );
    },
    async markChannelRead(channelId) {
      const generation = epoch,
        row = state.row(channelId);
      if (!allowed(channelId) || !row)
        throw new Error("Read target unavailable");
      const valid = () => !closed && epoch === generation && allowed(channelId);
      if (row.latest_message_id && row.latest_message_at === null)
        throw new Error("Latest message timestamp unavailable");
      if (!row.latest_message_id && !row.latest_message_complete)
        throw new Error("Latest message unknown; refresh before marking read");
      return serialize(channelId, async () => {
        const result = await state.enqueue(
          row.latest_message_id
            ? [
                {
                  intent: {
                    type: "mark_channel_read",
                    channel_id: channelId,
                    message_id: row.latest_message_id,
                  },
                  createdAt: row.latest_message_at ?? 0,
                },
              ]
            : [],
          (t) => t.channelId === channelId,
          valid,
        );
        if (valid() && forcedMessages.delete(channelId)) publish();
        return result;
      });
    },
    async markUnreadLocal(target) {
      const generation = epoch;
      if (!allowed(target.channelId))
        throw new Error("Read target unavailable");
      manualRevision.set(
        target.channelId,
        (manualRevision.get(target.channelId) ?? 0) + 1,
      );
      return serialize(target.channelId, () =>
        state.journal.markUnread(
          target,
          () => !closed && epoch === generation && allowed(target.channelId),
        ),
      );
    },
  });
  return {
    capability,
    state,
    accept(events: readonly RelayEvent[]) {
      for (const message of events) {
        const id = channelOf(message);
        if (id) state.invalidate(id);
      }
    },
    purge() {
      epoch++;
      for (const id of forcedMessages.keys())
        if (!allowed(id)) forcedMessages.delete(id);
      for (const id of entered) if (!allowed(id)) entered.delete(id);
      for (const stop of [...handles]) stop();
      previews.clear();
      state.purge();
    },
    stale() {
      epoch++;
      state.stale();
    },
    reconnect: state.reconnect,
    clear() {
      epoch++;
      forcedMessages.clear();
      entered.clear();
      for (const stop of [...handles]) stop();
      previews.clear();
      state.clear();
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      forcedMessages.clear();
      entered.clear();
      for (const stop of [...handles]) stop();
      stop();
      stopRoster();
      state.dispose();
      listeners.clear();
      snapshots.clear();
      activities.clear();
      previews.clear();
    },
  };
}
