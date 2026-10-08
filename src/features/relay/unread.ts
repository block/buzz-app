import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import type { InboxItem, InboxSnapshot } from "./inbox";
import { workflowOwner } from "./workflow-attribution";
import { foldMessages } from "./fold";
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
import type { SidebarApi, ReadCount, ReadTarget } from "./sidebar-api";
export type { UnreadTarget, ReadMutationResult } from "./sidebar-journal";
export type ReadSyncSnapshot = Readonly<{
  capability: "unsupported" | "frontier-sync";
  status: "loading" | "local" | "pending" | "reconciled" | "stale" | "error";
  completeness: "unknown" | "snapshot";
  error?: string | undefined;
  writeError?: string | undefined;
}>;
export type UnreadSnapshot = Readonly<{
  target: UnreadTarget;
  /** Opaque relay read anchor, not paired with the display activity time. */
  latestMessageId?: string;
  latestActivityAt?: number;
  latestMessageComplete?: boolean;
  unread: ReadCount;
  attention: ReadCount;
  unreadVisible?: boolean;
  attentionVisible?: boolean;
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
  /** Exact relay verdict; does not confer notification relevance. */
  relayRead?: boolean;
  viewing: boolean;
}>;
export type ThreadActivityItem = Readonly<{
  channelId: string;
  rootId: string;
  latestMessageId: string;
  authorId: string;
  workflowOwnerId?: string | undefined;
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
  inbox(): InboxSnapshot;
  subscribeInbox(listener: () => void): () => void;
  revision(): number;
  generation(): number;
  prepareChannelRead(channelId: string): () => Promise<ReadMutationResult>;
  snapshot(target: UnreadTarget): UnreadSnapshot;
  attention(channelId: string, messageId: string): MessageAttention;
  subscribe(target: UnreadTarget, listener: () => void): () => void;
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
  markChannelRead(channelId: string): Promise<ReadMutationResult>;
  /** Sweep the accessible listed unread channels; continue past individual failures. */
  markAllChannelsRead(): Promise<readonly ReadMutationResult[]>;
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
/** A message as the timeline presents it: its author's latest edit, agent envelope unwrapped. */
const present = (
  message: RelayEvent,
  evidence: readonly RelayEvent[] = [message],
) =>
  foldMessages(channelOf(message) ?? "", "", evidence, {
    includeReplies: true,
  }).find((row) => row.id === message.id)?.content ?? message.content;
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
  workflowAuthority,
  find,
  evidence = () => [],
  notify = (listener) => listener(),
}: {
  api: SidebarApi | undefined;
  storage?: SidebarStorage | undefined;
  scope: string;
  channels: ChannelQueries;
  reader: RelayReader;
  viewer: string;
  workflowAuthority?: string | undefined;
  find: (id: string) => RelayEvent | undefined;
  evidence?: () => readonly RelayEvent[];
  notify?: (listener: () => void) => void;
}) {
  let closed = false,
    epoch = 0;
  const admitted = (c: ChannelSummary) =>
    !c.cached && !!c.members?.includes(viewer);
  const allowed = (id: string) =>
    !closed && channels.list().channels.some((c) => c.id === id && admitted(c));
  // A traversal keeps only admitted rows. A cached restore admits none, so
  // walking it would fetch every page only to discard it; its confirmation
  // changes the roster key below and starts the one useful walk.
  const traversable = () => {
    const list = channels.list();
    return (
      list.status === "ready" &&
      (list.channels.some(admitted) || !list.channels.some((c) => c.cached))
    );
  };
  const state = createSidebarState({
    api,
    storage: storage ?? browserSidebarStorage(scope),
    allowed,
    notify,
  });
  const snapshots = new Map<string, UnreadSnapshot>(),
    activities = new Map<string, ThreadActivitySnapshot>();
  const previews = new Map<string, { event: RelayEvent; content: string }>();
  const listeners = new Set<() => void>();
  type Demand = {
    target: Extract<UnreadTarget, { kind: "message" }>;
    key?: string | undefined;
    lease?: ReturnType<typeof state.retain> | undefined;
  };
  const demands = new Set<Demand>();
  function releaseDemand(demand: Demand) {
    demand.lease?.dispose();
    demand.lease = undefined;
    demand.key = undefined;
  }
  function reconcileDemand() {
    const changed = [...demands].flatMap((demand) => {
      const message = event(demand.target.messageId);
      const resolved = message && context(message);
      const target =
        resolved?.channel_id === demand.target.channelId ? resolved : undefined;
      const key = target && contextKey(target);
      return key !== demand.key ? [{ demand, target, key }] : [];
    });
    // Release the whole changed set first: shared selectors must not temporarily
    // occupy both their old and new contexts at the retained-demand bound.
    for (const { demand } of changed) releaseDemand(demand);
    for (const { demand, target, key } of changed) {
      if (target) {
        const query = { target, message_ids: [demand.target.messageId] };
        try {
          demand.lease = state.retain(query);
        } catch {
          releaseInbox();
          demand.lease = state.retain(query);
        }
      }
      demand.key = key;
    }
    reconcileInbox();
  }
  const views = new Map<
    () => void,
    { ids: Set<string>; visible: () => boolean }
  >();
  const handles = new Set<() => void>();
  const manualRevision = new Map<string, number>();
  const lifetime = new AbortController();
  const event = (id: string) => {
    const value = find(id) ?? previews.get(id)?.event;
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
  // The session owns evidence; Inbox retains only bounded selector leases, never events.
  const inboxListeners = new Set<() => void>();
  const inboxDemand = new Map<string, ReturnType<typeof state.retain>>();
  let inboxDirty = true;
  let inboxSnapshot: InboxSnapshot | undefined;
  function candidates() {
    if (closed) return [];
    const all = evidence();
    // Jobs share the text/edit/delete presentation fold, not timeline admission.
    const folded = all.map((item) =>
      [45001, 45003].includes(item.kind) ? { ...item, kind: 9 } : item,
    );
    return channels
      .list()
      .channels.filter(
        (channel) => admitted(channel) && !state.attentionAbsent(channel.id),
      )
      .flatMap((channel) => {
        const content = new Map(
          foldMessages(channel.id, "", folded, { includeReplies: true }).map(
            (row) => [row.id, row.content],
          ),
        );
        return all.flatMap((message) => {
          if (
            channelOf(message) !== channel.id ||
            message.pubkey === viewer ||
            !api?.eligibleKinds?.includes(message.kind) ||
            !content.has(message.id)
          )
            return [];
          const target = context(message);
          return [
            {
              message,
              target,
              preview: content.get(message.id) ?? "",
              dm: channel.channelType === "dm",
            },
          ];
        });
      })
      .sort(
        (a, b) =>
          b.message.created_at - a.message.created_at ||
          a.message.id.localeCompare(b.message.id),
      );
  }
  const inboxKey = (id: string, target: ReadTarget) =>
    `${contextKey(target)}:${id}`;
  function releaseInbox() {
    for (const lease of inboxDemand.values()) lease.dispose();
    inboxDemand.clear();
    inboxDirty = true;
  }
  function reconcileInbox() {
    if (!inboxListeners.size || closed) return;
    const wanted = candidates()
      .flatMap(({ message, target }) =>
        target ? [{ key: inboxKey(message.id, target), message, target }] : [],
      )
      .slice(0, 100);
    const keys = new Set(wanted.map(({ key }) => key));
    for (const [key, lease] of inboxDemand)
      if (!keys.has(key)) {
        lease.dispose();
        inboxDemand.delete(key);
      }
    for (const { key, message, target } of wanted) {
      if (inboxDemand.has(key)) continue;
      try {
        inboxDemand.set(
          key,
          state.retain({ target, message_ids: [message.id] }),
        );
      } catch {
        // Notification demand goes first. Omitted selectors remain unresolved.
        break;
      }
    }
    inboxDirty = true;
  }
  function inbox(): InboxSnapshot {
    if (!inboxDirty && inboxSnapshot) return inboxSnapshot;
    inboxDirty = false;
    const current = state.sync();
    const groups = new Map<string, ReturnType<typeof candidates>>();
    let unresolved = false;
    for (const entry of candidates()) {
      const { message, target } = entry;
      if (!target) continue;
      const result = state.context(target);
      if (result?.status === "unavailable") continue;
      const verdict =
        result?.status === "available"
          ? result.messages.find((m) => m.message_id === message.id)
          : undefined;
      if (!verdict || verdict.status === "unknown") {
        unresolved = true;
        continue;
      }
      if (
        verdict.status !== "unread" ||
        !["direct", "mention", "conversation"].includes(verdict.reason ?? "")
      )
        continue;
      if (state.covered(target, message.id)) continue;
      const key = `${target.channel_id}:${entry.dm ? target.channel_id : (target.root_id ?? message.id)}`;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    const items: InboxItem[] = [];
    for (const [id, group] of groups) {
      group.sort(
        (a, b) =>
          a.message.created_at - b.message.created_at ||
          a.message.id.localeCompare(b.message.id),
      );
      const first = group[0],
        latest = group.at(-1);
      if (!first || !latest?.target) continue;
      const channelId = latest.target.channel_id;
      const rootId = group.find(({ target }) => target?.root_id)?.target
        ?.root_id;
      const target: UnreadTarget = latest.dm
        ? { kind: "channel", channelId }
        : rootId
          ? { kind: "thread", channelId, rootId }
          : { kind: "message", channelId, messageId: latest.message.id };
      items.push(
        Object.freeze({
          id,
          channelId,
          target,
          messageId: first.message.id,
          latestMessageId: latest.message.id,
          messageIds: Object.freeze(group.map(({ message }) => message.id)),
          ...(first.target?.root_id ? { rootId: first.target.root_id } : {}),
          authorId: first.message.pubkey,
          workflowOwnerId: workflowOwner(first.message, workflowAuthority),
          preview: first.preview,
          createdAt: latest.message.created_at,
          mentioned: group.some(({ message }) =>
            message.tags.some(
              ([name, value]) =>
                name === "p" && value?.toLowerCase() === viewer,
            ),
          ),
          thread: group.some(({ target }) => !!target?.root_id),
          unreadCount: group.length,
          manual:
            state.journal.manual(target) ||
            group.some(({ message }) =>
              state.journal.manual({
                kind: "message",
                channelId,
                messageId: message.id,
              }),
            ),
          readThrough: Object.freeze(
            !latest.dm && rootId
              ? group
                  .filter(({ target }) => target?.root_id === rootId)
                  .map(({ message }) => ({
                    target: { kind: "thread" as const, channelId, rootId },
                    messageId: message.id,
                  }))
              : [],
          ),
        }),
      );
    }
    items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const next: InboxSnapshot = Object.freeze({
      status:
        closed || current.status === "idle" || current.status === "unsupported"
          ? "idle"
          : current.status === "error"
            ? "error"
            : current.status === "loading"
              ? "loading"
              : "ready",
      items: Object.freeze(items),
      freshness: closed
        ? "unknown"
        : unresolved && freshness() === "observed"
          ? "stale"
          : freshness(),
      ...(current.status === "error" ? { error: current.error } : {}),
    });
    if (
      !inboxSnapshot ||
      JSON.stringify(inboxSnapshot) !== JSON.stringify(next)
    )
      inboxSnapshot = next;
    return inboxSnapshot;
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
      writeError: value.writeError,
    });
  }
  let syncSnapshot = sync();
  function publish() {
    reconcileDemand();
    inboxDirty = true;
    activities.clear();
    syncSnapshot = sync();
    for (const listener of listeners) notify(listener);
    for (const listener of inboxListeners) notify(listener);
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
    if (ensureRequested && traversable()) void state.ensure(true);
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
    let latestMessageId: string | undefined,
      latestActivityAt: number | undefined,
      latestMessageComplete: boolean | undefined;
    if (row && target.kind === "channel") {
      unread = row.unread;
      attention = row.attention;
      latestMessageId = row.latest_message_id ?? undefined;
      latestActivityAt = row.latest_message_at ?? undefined;
      latestMessageComplete = row.latest_message_complete;
    } else if (row && target.kind === "thread") {
      const thread = row.threads.items.find((t) => t.root_id === target.rootId);
      unread = thread?.unread ?? (row.threads.complete ? zero : unknown);
      attention = unread;
      latestMessageId = thread?.latest_reply_id;
      latestActivityAt = thread?.latest_reply_at;
      latestMessageComplete = row.threads.complete;
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
        attention = { status: "exact", value: status.reason === null ? 0 : 1 };
      } else if (status?.status === "read" || status?.status === "not_counted")
        unread = attention = zero;
    }
    // Only exact message identity proves optimistic coverage. A summary waits
    // for the relay rather than treating an opaque anchor as a local prefix.
    const message =
      target.kind === "message" ? event(target.messageId) : undefined;
    const resolved = message && context(message);
    const covered =
      !!message && !!resolved && state.covered(resolved, message.id);
    const hint = state.liveHint(target.channelId)?.unread;
    const hinted =
      !!hint &&
      (target.kind === "channel" ||
        (target.kind === "message"
          ? target.messageId === hint.id
          : hint.target?.root_id === target.rootId)) &&
      !(hint.target && state.covered(hint.target, hint.id));
    const result: UnreadSnapshot = Object.freeze({
      target,
      unreadVisible: (hasUnread(unread) && !covered) || hinted,
      attentionVisible:
        (hasUnread(attention) && !covered) || (hinted && hint.attention),
      unread,
      attention,
      ...(latestMessageId ? { latestMessageId } : {}),
      ...(latestActivityAt !== undefined ? { latestActivityAt } : {}),
      ...(latestMessageComplete !== undefined ? { latestMessageComplete } : {}),
      freshness: freshness(),
      manual:
        allowed(target.channelId) && state.journal.manual(target)
          ? "local-only"
          : "none",
      error: state.operationError(target.channelId) ?? state.sync().error,
    });
    if (
      cached &&
      cached.freshness === result.freshness &&
      cached.manual === result.manual &&
      cached.unreadVisible === result.unreadVisible &&
      cached.attentionVisible === result.attentionVisible &&
      cached.error === result.error &&
      sameCount(cached.unread, result.unread) &&
      sameCount(cached.attention, result.attention) &&
      cached.latestMessageId === result.latestMessageId &&
      cached.latestActivityAt === result.latestActivityAt &&
      cached.latestMessageComplete === result.latestMessageComplete
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
    const reason = status?.status === "unread" ? status.reason : null;
    const category =
      reason === "conversation"
        ? "thread"
        : reason === "direct" || reason === "mention"
          ? reason
          : undefined;
    const forced = state.journal.manual({
      kind: "message",
      channelId,
      messageId,
    });
    return {
      status:
        status?.status === "unread"
          ? reason !== null
            ? "eligible"
            : "ineligible"
          : status?.status === "read" ||
              status?.status === "not_counted" ||
              status?.status === "unavailable" ||
              result?.status === "unavailable"
            ? "ineligible"
            : "unknown",
      ...(category ? { category } : {}),
      ...(target.root_id ? { rootId: target.root_id } : {}),
      ...(mentioned ? { mentioned: true } : {}),
      forced,
      unread:
        message.pubkey !== viewer &&
        (forced ||
          (status?.status === "unread" && !state.covered(target, messageId))),
      relayRead: status?.status === "read",
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
            .filter((t) => t.unread.status === "unknown" || hasUnread(t.unread))
            .map((t) => {
              const preview = event(t.latest_reply_id);
              return {
                channelId,
                rootId: t.root_id,
                latestMessageId: t.latest_reply_id,
                authorId: preview?.pubkey ?? "",
                workflowOwnerId: preview
                  ? workflowOwner(preview, workflowAuthority)
                  : undefined,
                createdAt: t.latest_reply_at,
                preview: preview
                  ? (previews.get(preview.id)?.content ?? present(preview))
                  : "Open thread to read",
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
  function prepareChannelRead(channelId: string) {
    const generation = epoch,
      row = state.row(channelId);
    if (!allowed(channelId) || !row) throw new Error("Read target unavailable");
    const valid = () => !closed && epoch === generation && allowed(channelId);
    if (!row.latest_message_id && !row.latest_message_complete)
      throw new Error("Latest message unknown; refresh before marking read");
    const keys = state.journal.manualKeys(channelId);
    const intents: AnchoredRead[] = row.latest_message_id
      ? [
          {
            intent: {
              type: "mark_channel_read",
              channel_id: channelId,
              message_id: row.latest_message_id,
            },
          },
        ]
      : [];
    return () =>
      state.enqueue(intents, (t) => keys.has(unreadTargetKey(t)), valid);
  }

  const capability: UnreadCapability = Object.freeze<UnreadCapability>({
    inbox,
    subscribeInbox(listener) {
      inboxListeners.add(listener);
      reconcileInbox();
      inboxDirty = true;
      void capability.ensure();
      return () => {
        inboxListeners.delete(listener);
        if (!inboxListeners.size) releaseInbox();
        inboxDirty = true;
      };
    },
    revision: state.journal.revision,
    generation: () => epoch,
    snapshot,
    attention,
    activity,
    subscribe(target, listener) {
      const demand: Demand | undefined =
        target.kind === "message" ? { target } : undefined;
      if (demand) {
        if (demands.size >= 1000)
          throw new Error("Read context capacity reached");
        demands.add(demand);
        try {
          reconcileDemand();
        } catch (error) {
          demands.delete(demand);
          releaseDemand(demand);
          throw error;
        }
      }
      const off = subscribe(listener);
      return () => {
        off();
        if (demand) {
          demands.delete(demand);
          releaseDemand(demand);
          publish();
        }
      };
    },
    subscribeActivity: (_channelId, listener) => subscribe(listener),
    async loadActivity(channelId) {
      const items = activity(channelId).items;
      if (!items?.length || !allowed(channelId)) return;
      const generation = epoch;
      const ids = items.map((t) => t.latestMessageId);
      const found = await reader.read(
        [
          { ids, limit: 5 },
          { kinds: [40003], "#e": ids, limit: 500 },
        ],
        { signal: lifetime.signal, priority: "background" },
      );
      if (closed || epoch !== generation || !allowed(channelId)) return;
      for (const message of found)
        if (ids.includes(message.id) && channelOf(message) === channelId) {
          if (previews.size >= 100)
            previews.delete(previews.keys().next().value ?? "");
          previews.set(message.id, {
            event: message,
            content: present(message, found),
          });
        }
      publish();
    },
    sync: () => syncSnapshot,
    subscribeSync: subscribe,
    ensure: () => {
      ensureRequested = true;
      return traversable() ? state.ensure() : Promise.resolve();
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
          const intents: AnchoredRead[] = [];
          for (const id of new Set(ids)) {
            if (observed.has(id)) continue;
            const message = event(id),
              target = message && context(message);
            if (
              !message ||
              !target ||
              target.channel_id !== channelId ||
              !api?.eligibleKinds?.includes(message.kind)
            )
              continue;
            intents.push({
              intent: { type: "mark_through", target, message_id: id },
            });
          }
          if (intents.length) await state.enqueue(intents, () => false, valid);
          for (const { intent } of intents) observed.add(intent.message_id);
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
      return state.enqueue(
        [
          {
            intent: {
              type: "mark_through",
              target: expected,
              message_id: messageId,
            },
          },
        ],
        (t) => unreadTargetKey(t) === unreadTargetKey(target),
        () => !closed && epoch === generation && allowed(target.channelId),
      );
    },
    prepareChannelRead,
    async markChannelRead(channelId) {
      return prepareChannelRead(channelId)();
    },
    async markAllChannelsRead() {
      if (closed) throw new Error("Read target unavailable");
      const pending = channels
        .list()
        .channels.filter((channel) => allowed(channel.id))
        .map((channel) => channel.id)
        .filter((channelId) => {
          const current = snapshot({ kind: "channel", channelId });
          return (
            current.unreadVisible || state.journal.hasManualInChannel(channelId)
          );
        });
      // Reserve each fixed cut and local clear in invocation order before yielding.
      // The journal still commits per channel through its existing serial queue.
      const settled = await Promise.allSettled(
        pending.map((channelId) => capability.markChannelRead(channelId)),
      );
      const results: ReadMutationResult[] = [];
      let failure: unknown;
      let failed = false;
      for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") results.push(result.value);
        else if (allowed(pending[index] ?? "")) {
          if (!failed) failure = result.reason;
          failed = true;
        }
      }
      if (failed) throw failure;
      return results;
    },
    async markUnreadLocal(target) {
      const generation = epoch;
      if (!allowed(target.channelId))
        throw new Error("Read target unavailable");
      if (target.kind === "message") {
        const message = event(target.messageId);
        if (!message || context(message)?.channel_id !== target.channelId)
          throw new Error("Message does not belong to the read target");
      }
      manualRevision.set(
        target.channelId,
        (manualRevision.get(target.channelId) ?? 0) + 1,
      );
      return state.journal.markUnread(
        target,
        () => !closed && epoch === generation && allowed(target.channelId),
      );
    },
  });
  return {
    capability,
    state,
    event,
    retainedEditIds(ids: readonly string[]) {
      if (closed) return [];
      const all = evidence(),
        targets = new Set(ids);
      const deleted = (message: RelayEvent) =>
        all.some(
          (item) =>
            [5, 9005].includes(item.kind) &&
            item.pubkey === message.pubkey &&
            item.tags.some(([name, id]) => name === "e" && id === message.id),
        );
      return all
        .filter(
          (edit) =>
            edit.kind === 40003 &&
            !deleted(edit) &&
            edit.tags.some(([name, id]) => {
              const original = id && targets.has(id) ? event(id) : undefined;
              return (
                name === "e" &&
                original &&
                api?.eligibleKinds?.includes(original.kind) &&
                original.pubkey === edit.pubkey &&
                !deleted(original)
              );
            }),
        )
        .map((edit) => edit.id);
    },
    live(events: readonly RelayEvent[]) {
      for (const message of events) {
        const channelId = channelOf(message);
        if (
          !channelId ||
          !allowed(channelId) ||
          !api?.eligibleKinds?.includes(message.kind)
        )
          continue;
        const target = context(message);
        const direct =
          channels.list().channels.find((c) => c.id === channelId)
            ?.channelType === "dm" ||
          message.tags.some(
            ([name, value]) =>
              (name === "p" && value?.toLowerCase() === viewer) ||
              (name === "broadcast" && value === "1"),
          );
        state.live(
          channelId,
          {
            id: message.id,
            createdAt: message.created_at,
            ...(target ? { target } : {}),
            attention: direct,
          },
          message.pubkey !== viewer && (direct || !threadReference(message)),
        );
      }
    },
    accept(events: readonly RelayEvent[]) {
      for (const message of events) {
        const id = channelOf(message);
        if (id) state.invalidate(id);
      }
      reconcileDemand();
      inboxDirty = true;
      for (const listener of inboxListeners) notify(listener);
    },
    purge() {
      epoch++;
      for (const stop of [...handles]) stop();
      previews.clear();
      releaseInbox();
      state.purge();
    },
    stale() {
      epoch++;
      state.stale();
    },
    reconnect: state.reconnect,
    clear() {
      epoch++;
      for (const stop of [...handles]) stop();
      previews.clear();
      for (const demand of demands) releaseDemand(demand);
      releaseInbox();
      state.clear();
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      for (const stop of [...handles]) stop();
      stop();
      stopRoster();
      for (const demand of demands) releaseDemand(demand);
      demands.clear();
      releaseInbox();
      inboxListeners.clear();
      inboxDirty = true;
      state.dispose();
      listeners.clear();
      snapshots.clear();
      activities.clear();
      previews.clear();
    },
  };
}
