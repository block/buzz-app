import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import {
  effectiveFrontier,
  overrideActive,
  targetKey,
  type ReadTarget,
} from "./read-state-model";
import type {
  createReadState,
  ReadMutationResult,
  ReadSyncSnapshot,
} from "./read-state";
import type { RelayReader } from "./reader";

export type UnreadSnapshot = Readonly<{
  target: ReadTarget;
  /** null means unobserved/denied, never a fabricated zero or an exact relay total. */
  observedCount: number | null;
  attentionCount: number | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  manual: "none" | "local-only" | "remote";
  error?: string | undefined;
}>;
export type ReadingHandle = Readonly<{
  /** Only message IDs actually visible to the active consumer; no caller timestamps. */
  observe(messageIds: readonly string[]): Promise<void>;
  dispose(): void;
}>;
export interface UnreadCapability {
  snapshot(target: ReadTarget): UnreadSnapshot;
  subscribe(target: ReadTarget, listener: () => void): () => void;
  sync(): ReadSyncSnapshot;
  subscribeSync(listener: () => void): () => void;
  ensure(): Promise<void>;
  refresh(): Promise<void>;
  retrySync(): Promise<void>;
  reading(channelId: string): ReadingHandle;
  /** Explicit prefix intent, unlike individual-message visibility observations. */
  markThrough(
    target: ReadTarget,
    messageId: string,
  ): Promise<ReadMutationResult>;
  markUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  readonly syncedManualUnread: false;
}
const contentKind = (event: RelayEvent) =>
  event.kind === 9 || event.kind === 40002;
const channelOf = (event: RelayEvent) => {
  const tags = event.tags.filter(([name]) => name === "h");
  return tags.length === 1 ? tags[0]?.[1] : undefined;
};
const replyTo = (event: RelayEvent) =>
  event.tags.find(
    ([name, , , marker]) => name === "e" && marker === "reply",
  )?.[1];
/** Bounded verified evidence and one projection; no sidebar counters, sockets or implicit reads. */
export function createUnread({
  reads,
  channels,
  reader,
  viewer,
  notify = (listener) => listener(),
}: {
  reads: ReturnType<typeof createReadState>;
  channels: ChannelQueries;
  reader: RelayReader;
  viewer: string;
  notify?: (listener: () => void) => void;
}) {
  let closed = false,
    epoch = 0;
  let requested = false;
  let freshness: UnreadSnapshot["freshness"] = "unknown";
  let error: string | undefined;
  let refresh: Promise<void> | undefined;
  const lifetime = new AbortController();
  const events = new Map<string, RelayEvent>();
  const known = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, UnreadSnapshot>();
  const handles = new Set<() => void>();
  let bytes = 0;
  const allowed = (id: string) =>
    channels
      .list()
      .channels.some(
        (channel) => channel.id === id && channel.members?.includes(viewer),
      );
  const keyFor = (target: ReadTarget) =>
    `${target.channelId}:${targetKey(target)}`;
  function root(event: RelayEvent): string | undefined {
    const channel = channelOf(event);
    let current = event;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current.id)) return;
      seen.add(current.id);
      const parent = replyTo(current);
      if (!parent) return current.id;
      const explicit = current.tags.find(
        ([name, , , marker]) => name === "e" && marker === "root",
      )?.[1];
      const next = events.get(explicit ?? parent);
      if (!next || !contentKind(next) || channelOf(next) !== channel) return;
      current = next;
    }
  }
  type Evidence = {
    event: RelayEvent;
    rootId: string | undefined;
    mentioned: boolean;
  };
  let indexed = false;
  const byChannel = new Map<string, Evidence[]>();
  const tombstones = new Set<string>();
  const participants = new Set<string>();
  function indexEvidence() {
    if (indexed) return;
    indexed = true;
    byChannel.clear();
    tombstones.clear();
    participants.clear();
    for (const event of events.values()) {
      if (event.kind !== 5 && event.kind !== 9005) continue;
      for (const [name, id] of event.tags)
        if (name === "e" && id && events.get(id)?.pubkey === event.pubkey)
          tombstones.add(id);
    }
    for (const event of events.values()) {
      if (!contentKind(event) || tombstones.has(event.id)) continue;
      const channel = channelOf(event);
      if (!channel) continue;
      const rootId = root(event);
      if (event.pubkey === viewer && rootId) participants.add(rootId);
      const rows = byChannel.get(channel) ?? [];
      rows.push({
        event,
        rootId: replyTo(event) ? rootId : undefined,
        mentioned: event.tags.some(
          ([name, value]) => name === "p" && value === viewer,
        ),
      });
      byChannel.set(channel, rows);
    }
  }
  function deleted(event: RelayEvent): boolean {
    indexEvidence();
    return tombstones.has(event.id);
  }
  function inTarget(event: RelayEvent, target: ReadTarget) {
    return (
      channelOf(event) === target.channelId &&
      (target.kind === "channel" ||
        (target.kind === "message" && target.messageId === event.id) ||
        (target.kind === "thread" &&
          !!replyTo(event) &&
          root(event) === target.rootId))
    );
  }
  function compute(target: ReadTarget): UnreadSnapshot {
    const key = targetKey(target);
    const accessible =
      allowed(target.channelId) &&
      (target.kind === "channel" ||
        (() => {
          const event = events.get(
            target.kind === "thread" ? target.rootId : target.messageId,
          );
          return (
            !!event &&
            channelOf(event) === target.channelId &&
            contentKind(event)
          );
        })());
    if (!accessible)
      return Object.freeze({
        target,
        observedCount: null,
        attentionCount: null,
        coverage: "unknown",
        freshness: "unknown",
        manual: "none",
      });
    const evidence = known.has(target.channelId);
    const state = reads.state();
    let count = 0,
      attention = 0;
    const dm =
      channels
        .list()
        .channels.find((channel) => channel.id === target.channelId)
        ?.channelType === "dm";
    indexEvidence();
    for (const { event, rootId, mentioned } of byChannel.get(
      target.channelId,
    ) ?? []) {
      if (event.pubkey === viewer || !inTarget(event, target)) continue;
      const frontier = effectiveFrontier(
        state,
        `msg:${event.id}`,
        target.channelId,
        rootId,
      );
      const forced =
        overrideActive(state.overrides[`msg:${event.id}`], frontier) ||
        overrideActive(
          state.overrides[target.channelId],
          effectiveFrontier(state, target.channelId),
        ) ||
        (rootId !== undefined &&
          overrideActive(
            state.overrides[`thread:${rootId}`],
            effectiveFrontier(state, `thread:${rootId}`, target.channelId),
          ));
      if (frontier !== undefined && event.created_at <= frontier && !forced)
        continue;
      count++;
      if (dm || mentioned || (rootId && participants.has(rootId))) attention++;
    }
    const manual = reads.localUnread(key)
      ? "local-only"
      : overrideActive(
            state.overrides[key],
            effectiveFrontier(state, key, target.channelId),
          )
        ? "remote"
        : "none";
    return Object.freeze({
      target,
      observedCount: evidence ? count : null,
      attentionCount: evidence ? attention : null,
      coverage: evidence ? "observed" : "unknown",
      freshness,
      manual,
      ...(error ? { error } : {}),
    });
  }
  const equal = (a: UnreadSnapshot, b: UnreadSnapshot) =>
    a.observedCount === b.observedCount &&
    a.attentionCount === b.attentionCount &&
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.manual === b.manual &&
    a.error === b.error;
  function snapshot(target: ReadTarget) {
    const key = keyFor(target),
      previous = snapshots.get(key);
    if (previous) return previous;
    const value = compute(Object.freeze({ ...target }));
    if (snapshots.size >= 4096) {
      for (const key of snapshots.keys())
        if (!listeners.has(key)) snapshots.delete(key);
      if (snapshots.size >= 4096)
        throw new Error("Unread selector capacity reached");
    }
    snapshots.set(key, value);
    return value;
  }
  function publish() {
    if (closed) return;
    const changed: string[] = [];
    for (const [key, old] of snapshots) {
      const next = compute(old.target);
      if (!equal(old, next)) {
        snapshots.set(key, next);
        changed.push(key);
      }
    }
    // Replace ALL projections before the first possibly reentrant callback.
    for (const key of changed)
      for (const listener of listeners.get(key) ?? []) notify(listener);
  }
  const stopRead = reads.subscribe(publish);
  function purge() {
    // A revoke/regrant must not revive a transaction accepted under the old access epoch.
    epoch++;
    const denied = new Set([...known].filter((channel) => !allowed(channel)));
    for (const channel of denied) known.delete(channel);
    for (const [id, event] of events) {
      const channel = channelOf(event);
      if (
        channel
          ? !allowed(channel)
          : !event.tags.some(
              ([name, value]) =>
                name === "e" &&
                value &&
                (() => {
                  const target = events.get(value);
                  const owner = target && channelOf(target);
                  return owner && allowed(owner);
                })(),
            )
      )
        events.delete(id);
    }
    indexed = false;
    // Reference-only tombstones are retained only with a still-accessible target.
    bytes = [...events.values()].reduce(
      (total, event) =>
        total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    publish();
  }
  let accessKey = "";
  const stopChannels = channels.subscribeList(() => {
    const next = channels
      .list()
      .channels.filter((channel) => allowed(channel.id))
      .map((channel) => channel.id)
      .sort()
      .join(",");
    if (next === accessKey) {
      // Metadata (notably DM type) changes projections, not reading/access epochs.
      publish();
    } else {
      accessKey = next;
      purge();
    }
  });
  async function repair() {
    requested = true;
    if (closed) return;
    if (refresh) return refresh;
    const generation = epoch;
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(10000),
    ]);
    refresh = (async () => {
      await reads.ensure();
      const ids = channels
        .list()
        .channels.filter((channel) => allowed(channel.id))
        .map((channel) => channel.id);
      if (!ids.length) return;
      try {
        // ONE bounded recent observation across the roster, never one head request per row.
        const result = await reader.read(
          [{ kinds: [9, 40002], "#h": ids, include_aux: true, limit: 500 }],
          { signal, priority: "background" },
        );
        if (closed || generation !== epoch) return;
        accept(result);
        freshness = "observed";
        error = undefined;
        publish();
      } catch (cause) {
        if (closed || generation !== epoch) return;
        freshness = "stale";
        error =
          cause instanceof Error ? cause.message : "Unread observation failed";
        publish();
      }
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  }
  function accept(batch: readonly RelayEvent[]) {
    if (closed) return;
    const changed = new Set<string>();
    indexed = false;
    const incoming = new Map(batch.map((event) => [event.id, event]));
    for (const event of batch) {
      if (![9, 40002, 5, 9005].includes(event.kind) || events.has(event.id))
        continue;
      const channel =
        channelOf(event) ??
        event.tags
          .flatMap(([name, value]) =>
            name === "e" && value
              ? [channelOf(incoming.get(value) ?? events.get(value) ?? event)]
              : [],
          )
          .find(Boolean);
      if (!channel || !allowed(channel)) continue;
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (events.size >= 4096 || bytes + size > 8 * 1024 * 1024) {
        events.clear();
        known.clear();
        bytes = 0;
        error = "Unread observation capacity reached; refresh available";
        freshness = "stale";
        publish();
        return;
      }
      events.set(event.id, event);
      bytes += size;
      known.add(channel);
      changed.add(channel);
    }
    if (changed.size) {
      freshness = "observed";
      publish();
    }
  }
  function requireMessage(target: ReadTarget, id: string) {
    targetKey(target);
    const event = events.get(id);
    if (
      closed ||
      !allowed(target.channelId) ||
      !event ||
      !contentKind(event) ||
      deleted(event) ||
      channelOf(event) !== target.channelId
    )
      throw new Error("Verified readable message evidence unavailable");
    if (
      (target.kind === "thread" && root(event) !== target.rootId) ||
      (target.kind === "message" && target.messageId !== id)
    )
      throw new Error("Message does not belong to the read target");
    if (
      target.kind === "channel" &&
      replyTo(event) &&
      !event.tags.some(([name, value]) => name === "broadcast" && value === "1")
    )
      throw new Error("A thread reply cannot advance the channel frontier");
    return event;
  }
  const capability: UnreadCapability = Object.freeze<UnreadCapability>({
    snapshot,
    subscribe(target, listener) {
      snapshot(target);
      const key = keyFor(target),
        set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    sync: reads.snapshot,
    subscribeSync: reads.subscribe,
    ensure: () => (requested ? Promise.resolve() : repair()),
    refresh: async () => {
      await reads.refresh();
      await repair();
    },
    retrySync: async () => {
      await reads.refresh();
      await reads.flush();
    },
    syncedManualUnread: false,
    reading(channelId) {
      if (closed || !allowed(channelId) || handles.size >= 64)
        throw new Error("Reading handle unavailable");
      let active = true;
      const generation = epoch;
      const manualRevision = reads.revision();
      const observed = new Set<string>();
      const dispose = () => {
        active = false;
        handles.delete(dispose);
      };
      const valid = () =>
        active &&
        !closed &&
        generation === epoch &&
        allowed(channelId) &&
        (reads.localUnread(channelId) ?? 0) <= manualRevision;
      handles.add(dispose);
      return Object.freeze({
        dispose,
        async observe(ids: readonly string[]) {
          if (!valid() || ids.length > 128) return;
          for (const id of ids) {
            if (!valid() || observed.has(id)) continue;
            const target = {
              kind: "message" as const,
              channelId,
              messageId: id,
            };
            const event = requireMessage(target, id);
            if (
              (effectiveFrontier(
                reads.state(),
                targetKey(target),
                channelId,
                replyTo(event) ? root(event) : undefined,
              ) ?? -1) >= event.created_at
            ) {
              observed.add(id);
              continue;
            }
            await reads.read(
              targetKey(target),
              event.created_at,
              () => valid() && requireMessage(target, id) === event,
            );
            observed.add(id);
          }
        },
      });
    },
    async markThrough(target, id) {
      const event = requireMessage(target, id),
        generation = epoch;
      return reads.read(
        targetKey(target),
        event.created_at,
        () =>
          !closed &&
          generation === epoch &&
          requireMessage(target, id) === event,
        true,
      );
    },
    async markUnreadLocal(target) {
      const key = targetKey(target);
      const generation = epoch;
      const valid = () => {
        if (closed || generation !== epoch || !allowed(target.channelId))
          return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      return reads.markLocalUnread(key, valid);
    },
  });
  return {
    capability,
    // Private session evidence lookup; never seeds timeline windows or grants access.
    event(id: string) {
      const event = events.get(id);
      const channel = event && channelOf(event);
      return !closed && event && channel && allowed(channel)
        ? event
        : undefined;
    },
    accept,
    purge,
    reconnect() {
      if (requested) void reads.refresh().then(repair);
    },
    stale() {
      epoch++;
      freshness = "stale";
      reads.stale();
      publish();
    },
    clear() {
      epoch++;
      indexed = false;
      events.clear();
      known.clear();
      bytes = 0;
      freshness = "unknown";
      error = undefined;
      publish();
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      for (const stop of [...handles]) stop();
      stopRead();
      stopChannels();
      listeners.clear();
      snapshots.clear();
      events.clear();
      reads.dispose();
    },
  };
}
