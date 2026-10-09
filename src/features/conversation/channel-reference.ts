import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelQueries } from "../relay/contracts";

type Lookup = {
  /** Settled ids. A failed read is forgotten so a later mount can retry. */
  settled: Set<string>;
  queue: Set<string>;
  pending: Set<string>;
  listeners: Set<() => void>;
  scheduled: boolean;
};
const lookups = new WeakMap<ChannelQueries, Lookup>();
// The store bounds one exact read to 128 channels.
const BATCH = 128;

function lookup(queries: ChannelQueries) {
  let state = lookups.get(queries);
  if (!state) {
    state = {
      settled: new Set(),
      queue: new Set(),
      pending: new Set(),
      listeners: new Set(),
      scheduled: false,
    };
    lookups.set(queries, state);
  }
  return state;
}

/** Coalesce every reference rendered in one pass into bounded exact reads. */
function request(queries: ChannelQueries, id: string) {
  const state = lookup(queries);
  if (state.settled.has(id) || state.pending.has(id) || state.queue.has(id))
    return;
  state.queue.add(id);
  if (state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    const ids = [...state.queue];
    state.queue.clear();
    for (let start = 0; start < ids.length; start += BATCH) {
      const batch = ids.slice(start, start + BATCH);
      for (const id of batch) state.pending.add(id);
      void (queries.resolve?.(batch) ?? Promise.reject(new Error("No lookup")))
        .then(
          () => {
            for (const id of batch) state.settled.add(id);
          },
          () => {},
        )
        .finally(() => {
          for (const id of batch) state.pending.delete(id);
          for (const listener of state.listeners) listener();
        });
    }
  });
}

const noop = () => () => {};

/**
 * A channel-only link to a channel the reader hasn't joined. Open channels
 * resolve to a readable preview; the relay withholds a private channel's
 * metadata from non-members, so a settled lookup with no channel is reported
 * as unavailable (private, deleted or never valid look the same here).
 */
export function useChannelReference(
  queries: ChannelQueries | undefined,
  channelId: string | undefined,
) {
  const active =
    channelId && queries?.get && queries.resolve ? queries : undefined;
  // The list is replaced on every message preview; re-render only when a
  // field this reference shows could change.
  const key = useSyncExternalStore(
    active?.subscribeList ?? noop,
    () => (active && channelId ? referenceKey(active, channelId) : ""),
    () => "",
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!active) return () => {};
      const { listeners } = lookup(active);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [active],
  );
  const settled = useSyncExternalStore(
    subscribe,
    () => !!active && !!channelId && lookup(active).settled.has(channelId),
    () => false,
  );
  const ready = key.startsWith("ready");
  const channel = useMemo(
    () =>
      key.startsWith("ready:") && active && channelId
        ? active.get?.(channelId)
        : undefined,
    [active, channelId, key],
  );
  // Discovery owns access; reads wait for the list it has made ready.
  useEffect(() => {
    if (active && channelId && ready && !channel) request(active, channelId);
  }, [active, channelId, ready, channel]);
  return { channel, unavailable: ready && settled && !channel };
}

function referenceKey(queries: ChannelQueries, channelId: string) {
  if (queries.list().status !== "ready") return "";
  const channel = queries.get?.(channelId);
  return channel
    ? `ready:${JSON.stringify([
        channel.name,
        channel.description,
        channel.channelType,
        channel.private,
        channel.readOnly,
        channel.hidden,
        channel.archived,
        channel.members?.length,
      ])}`
    : "ready";
}
