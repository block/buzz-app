import { messageContentKind } from "./channel-kinds";
import type { ChannelWindow } from "./contracts";
import type { RelayEvent } from "./events";
import { RECOVERY_DELAYS_MS, type RecoverySource } from "./recovery";
import { threadReference } from "./thread-reference";

export const CHANNEL_ACTIVITY_KINDS = [9, 40002, 40008, 45001, 45003] as const;
const CHANNEL_BATCH = 128;

export type LatestMessage = Readonly<{
  id: string;
  createdAt: number;
  authorId: string;
  content: string;
}>;

/** A verified window's own head answers without the roster read. */
const verifiedHeads = new WeakMap<
  ChannelWindow,
  LatestMessage | null | undefined
>();
export function loadedPreview(
  window: ChannelWindow,
): LatestMessage | null | undefined {
  if (
    window.status !== "ready" ||
    window.freshness !== "verified" ||
    window.hasNewer ||
    window.refreshing
  )
    return undefined;
  if (verifiedHeads.has(window)) return verifiedHeads.get(window);
  let newest: LatestMessage | undefined;
  for (const row of window.rows) {
    if (row.threadRootId || row.delivery || row.audience === "agents") continue;
    if (
      !newest ||
      row.createdAt > newest.createdAt ||
      (row.createdAt === newest.createdAt && row.id < newest.id)
    )
      newest = row;
  }
  const result = newest ?? (window.rows.length ? undefined : null);
  verifiedHeads.set(window, result);
  return result;
}

/**
 * Up to 128 channels' newest events in one request: of any activity kind, or
 * top-level only. The session admits what it returns, so message bodies stay
 * in its canonical projections.
 */
export type ChannelHeadsReader = (
  channelIds: readonly string[],
  topLevel: boolean,
  signal: AbortSignal,
) => Promise<readonly RelayEvent[]>;

const channelOf = (event: RelayEvent) => {
  const channels = event.tags.filter(([name]) => name === "h");
  return channels.length === 1 ? channels[0]?.[1] : undefined;
};
const activityKind = (event: RelayEvent) =>
  CHANNEL_ACTIVITY_KINDS.includes(event.kind as never);

/**
 * Every listed channel's head, read once for the whole roster: when it was
 * last active, and whether its newest top-level message has been read. A
 * channel is read when it joins the roster and never again; live traffic
 * advances it from there. Lists order and preview from this, so neither
 * depends on which rows are on screen.
 *
 * Relay reads per client: ceil(channels / 128) when the roster first loads,
 * plus one more pass over only the channels whose newest event is not a
 * top-level message. A reconnect reads nothing; a join reads that channel.
 */
export function createChannelHeads({
  read,
  readable,
  notify = (listener) => listener(),
}: {
  read: ChannelHeadsReader | undefined;
  readable(channelId: string): boolean;
  notify?: (listener: () => void) => void;
}) {
  /** Last activity; null is a read that found none. */
  let values = new Map<string, number | null>();
  /** Channels whose newest top-level message was read, or that have none. */
  const settled = new Set<string>();
  let roster: readonly string[] = [];
  let failed = false;
  let revision = 0;
  let closed = false;
  let active: AbortController | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(ids?: readonly string[]) => void>();
  /** Channels to announce, or undefined for every one. */
  const tell = (ids?: readonly string[]) => {
    for (const listener of [...listeners]) notify(() => listener(ids));
  };
  /** A head or the status changed, so the channel list reads differently. */
  const publish = (ids?: readonly string[]) => {
    revision++;
    tell(ids);
  };
  const pending = () => roster.filter((id) => !settled.has(id) && readable(id));
  const status = () =>
    !read
      ? ("unavailable" as const)
      : active || scheduled !== undefined
        ? ("loading" as const)
        : failed
          ? ("error" as const)
          : roster.length && !pending().length
            ? ("ready" as const)
            : ("idle" as const);

  async function drain() {
    if (closed || active || !read) return;
    const ids = pending();
    if (!ids.length) return;
    const controller = new AbortController();
    active = controller;
    failed = false;
    publish([]);
    const batch = async (channelIds: readonly string[], topLevel: boolean) => {
      const events = await read(
        channelIds,
        topLevel,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      );
      controller.signal.throwIfAborted();
      const newest = new Map<string, RelayEvent>();
      for (const event of events) {
        const id = channelOf(event);
        if (
          id &&
          channelIds.includes(id) &&
          activityKind(event) &&
          event.created_at > (newest.get(id)?.created_at ?? -1)
        )
          newest.set(id, event);
      }
      return newest;
    };
    try {
      for (let offset = 0; offset < ids.length; offset += CHANNEL_BATCH) {
        const asked = ids.slice(offset, offset + CHANNEL_BATCH);
        const newest = await batch(asked, false);
        // The roster may have dropped a channel while its read was out.
        const channelIds = asked.filter((id) => roster.includes(id));
        const threaded: string[] = [];
        for (const id of channelIds) {
          const event = newest.get(id);
          // Live activity that arrived during the read is newer than it.
          if ((values.get(id) ?? -1) < (event?.created_at ?? 0))
            values.set(id, event?.created_at ?? null);
          if (
            event &&
            (!messageContentKind(event.kind) || threadReference(event))
          )
            threaded.push(id);
          else settled.add(id);
        }
        publish(channelIds.filter((id) => settled.has(id)));
        if (!threaded.length) continue;
        await batch(threaded, true);
        const kept = threaded.filter((id) => roster.includes(id));
        for (const id of kept) settled.add(id);
        publish(kept);
      }
    } catch {
      if (closed || controller.signal.aborted) return;
      failed = true;
    } finally {
      if (active === controller) active = undefined;
    }
    if (closed) return;
    publish([]);
    if (!failed) void drain();
  }
  /** Spread the first read across clients that all start at once. */
  function schedule() {
    if (closed || !read || active || scheduled !== undefined) return;
    if (!pending().length) return;
    scheduled = setTimeout(
      () => {
        scheduled = undefined;
        void drain();
      },
      (RECOVERY_DELAYS_MS[0] ?? 1_000) * (0.25 + Math.random() / 4),
    );
    publish([]);
  }
  const retry = () => {
    failed = false;
    schedule();
  };
  const recovery: RecoverySource = {
    status: () =>
      status() === "loading"
        ? "busy"
        : status() === "error"
          ? "failed"
          : "settled",
    subscribe(listener) {
      const heard = () => listener();
      listeners.add(heard);
      return () => {
        listeners.delete(heard);
      };
    },
    retry,
    reauthorize: retry,
  };

  return {
    recovery,
    status,
    last: (channelId: string) => values.get(channelId) ?? undefined,
    known: (channelId: string) => values.has(channelId),
    /** The channel's newest top-level message is in the session's projections. */
    settled: (channelId: string) => settled.has(channelId),
    revision: () => revision,
    /** Calls back with the channels a change touched; none given means all. */
    subscribe(listener: (ids?: readonly string[]) => void) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The channels to keep heads for. Only those not yet read are read. */
    cover(ids: readonly string[]) {
      if (closed) return;
      roster = [...new Set(ids)];
      const wanted = new Set(roster);
      let dropped = false;
      for (const id of [...values.keys()])
        if (!wanted.has(id)) {
          values.delete(id);
          settled.delete(id);
          dropped = true;
        }
      if (dropped) publish([]);
      schedule();
    },
    /** Verified live activity advances a channel; it never moves one back. */
    accept(events: readonly RelayEvent[]) {
      if (closed) return;
      const changed: string[] = [];
      for (const event of events) {
        if (!activityKind(event)) continue;
        const id = channelOf(event);
        if (!id || event.created_at <= (values.get(id) ?? -1)) continue;
        values.set(id, event.created_at);
        changed.push(id);
      }
      if (changed.length) publish(changed);
    },
    /** The session admitted events: their channels' heads may have moved. */
    observed(events: readonly RelayEvent[]) {
      if (closed) return;
      const ids = new Set<string>();
      for (const event of events) {
        const id = channelOf(event);
        if (id) ids.add(id);
      }
      if (ids.size) tell([...ids]);
    },
    /** The head message is gone: read the channel again for the one before. */
    reread(channelId: string) {
      if (closed || !settled.delete(channelId)) return;
      schedule();
    },
    /** Access loss drops the channels no longer readable; the rest keep order. */
    retain(keep: (channelId: string) => boolean) {
      if (closed) return;
      active?.abort();
      active = undefined;
      let dropped = false;
      for (const id of [...values.keys()])
        if (!keep(id)) {
          values.delete(id);
          settled.delete(id);
          dropped = true;
        }
      if (dropped) publish();
      schedule();
    },
    clear() {
      if (closed) return;
      const changed =
        values.size > 0 || failed || !!active || scheduled !== undefined;
      active?.abort();
      active = undefined;
      clearTimeout(scheduled);
      scheduled = undefined;
      failed = false;
      values = new Map();
      settled.clear();
      if (changed) publish();
      schedule();
    },
    dispose() {
      closed = true;
      active?.abort();
      active = undefined;
      clearTimeout(scheduled);
      scheduled = undefined;
      values.clear();
      settled.clear();
      listeners.clear();
    },
  };
}
