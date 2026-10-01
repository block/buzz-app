import type {
  SidebarApi,
  ChannelReadSummary,
  ContextQuery,
  ContextState,
  ReadTarget,
} from "./sidebar-api";
import {
  createSidebarJournal,
  type SidebarStorage,
  type AnchoredRead,
  type PendingRead,
  type SidebarManualTarget,
} from "./sidebar-journal";
import { ReadError } from "./errors";

const MAX_CHANNELS = 1000;
const MAX_CONTEXTS = 1000;
const MAX_SELECTORS = 1000;
const PERIOD_MS = 60000;
export type SidebarStatus =
  | "idle"
  | "loading"
  | "ready"
  | "stale"
  | "error"
  | "unsupported";
export type SidebarSync = Readonly<{
  status: SidebarStatus;
  pending: number;
  error?: string | undefined;
  // Write health is separate: a read can neither cause nor clear it.
  writeError?: string | undefined;
}>;
export const contextKey = (target: ContextQuery["target"]) =>
  `${target.channel_id}:${target.root_id ?? ""}`;

/** Session-owned private projection. Live traffic invalidates; only relay responses count. */
export function createSidebarState({
  api,
  storage,
  allowed,
  notify = (listener) => listener(),
  visible = () =>
    typeof document === "undefined" || document.visibilityState === "visible",
}: {
  api: SidebarApi | undefined;
  storage: SidebarStorage;
  allowed: (channelId: string) => boolean;
  notify?: (listener: () => void) => void;
  visible?: () => boolean;
}) {
  let closed = false,
    epoch = 0,
    revision = 0,
    requested = false;
  let sync: SidebarSync = Object.freeze({
    status: api ? "idle" : "unsupported",
    pending: 0,
  });
  const rows = new Map<string, ChannelReadSummary>();
  const operationErrors = new Map<string, string>();
  const contexts = new Map<string, ContextState>();
  // Applied operands outlive journal acknowledgement until each presentation
  // surface receives applicable evidence. Counts themselves are never edited.
  type LiveHint = {
    id: string;
    createdAt: number;
    target?: ReadTarget;
    attention: boolean;
    revision: number;
  };
  const liveHints = new Map<string, { latest: LiveHint; unread?: LiveHint }>();
  const saving = new Map<symbol, AnchoredRead[]>();
  const applied = new Map<
    string,
    {
      read: PendingRead;
      revision: number;
      settled: Set<string>;
    }
  >();
  const readChannel = (read: AnchoredRead) =>
    read.intent.type === "mark_through"
      ? read.intent.target.channel_id
      : read.intent.channel_id;
  function covered(
    target: ContextQuery["target"],
    timestamp: number,
    channel = false,
    messageId?: string,
  ) {
    if (!allowed(target.channel_id)) return false;
    const surface = channel
      ? `${target.channel_id}:sidebar`
      : `${contextKey(target)}:${messageId ?? "summary"}`;
    return [...saving.values()]
      .flat()
      .concat(
        journal.snapshot().pending,
        [...applied.values()]
          .filter((entry) => !entry.settled.has(surface))
          .map((entry) => entry.read),
      )
      .some(
        (read) =>
          readChannel(read) === target.channel_id &&
          read.createdAt >= timestamp &&
          (read.intent.type === "mark_channel_read" ||
            (!channel && read.intent.target.root_id === target.root_id)),
      );
  }
  function settle(channelId: string, surface: string, watermark: number) {
    for (const entry of applied.values())
      if (readChannel(entry.read) === channelId && entry.revision <= watermark)
        entry.settled.add(surface);
  }

  const wanted = new Map<symbol, ContextQuery>();
  const dirty = new Set<string>();
  const listeners = new Set<() => void>();
  let traversal: Promise<void> | undefined, flushing: Promise<void> | undefined;
  let traversalDirty = false,
    draining = false;
  let active = new AbortController();
  let debounce: ReturnType<typeof setTimeout> | undefined,
    periodic: ReturnType<typeof setTimeout> | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  let writes: Promise<unknown> = Promise.resolve();
  // A relay Retry-After paces the lane it refused, not unrelated requests.
  const retry: {
    [lane in "read" | "write"]?: { at: number; error: ReadError };
  } = {};
  const journal = createSidebarJournal(storage, () => publish());
  const ready = journal.reload().catch((error) => fail(error));
  function publish(change: Partial<SidebarSync> = {}) {
    sync = Object.freeze({
      ...sync,
      ...change,
      pending: journal.snapshot().pending.length,
    });
    revision++;
    for (const listener of listeners) notify(listener);
  }
  function fail(error: unknown, write = false) {
    if (
      closed ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      return;
    const message =
      error instanceof Error ? error.message : "Sidebar unavailable";
    publish(
      write ? { writeError: message } : { status: "error", error: message },
    );
  }
  function schedule<T>(
    work: (signal: AbortSignal, generation: number) => Promise<T>,
    lane: "read" | "write" = "read",
  ): Promise<T> {
    const generation = epoch,
      owner = active;
    const result = (lane === "write" ? writes : serial).then(async () => {
      if (closed || generation !== epoch)
        throw new DOMException("Sidebar cancelled", "AbortError");
      const refused = retry[lane];
      if (refused && performance.now() < refused.at) throw refused.error;
      try {
        return await work(owner.signal, generation);
      } catch (error) {
        if (error instanceof ReadError && error.retryAfterMs !== undefined)
          retry[lane] = { at: performance.now() + error.retryAfterMs, error };
        throw error;
      }
    });
    if (lane === "write") writes = result.catch(() => {});
    else serial = result.catch(() => {});
    return result;
  }
  function current(generation: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (closed || generation !== epoch)
      throw new DOMException("Sidebar cancelled", "AbortError");
  }
  function applyRow(row: ChannelReadSummary, watermark: number) {
    if (!allowed(row.channel_id)) {
      rows.delete(row.channel_id);
      return;
    }
    if (!rows.has(row.channel_id) && rows.size >= MAX_CHANNELS)
      throw new Error("Sidebar exceeds channel capacity");
    rows.set(row.channel_id, row);
    const hint = liveHints.get(row.channel_id);
    if (
      hint &&
      hint.latest.revision <= watermark &&
      row.latest_message_complete &&
      row.unread.status !== "unknown" &&
      row.attention.status !== "unknown"
    )
      liveHints.delete(row.channel_id);
    if (
      row.latest_message_complete &&
      row.unread.status === "exact" &&
      row.attention.status === "exact"
    )
      settle(row.channel_id, `${row.channel_id}:sidebar`, watermark);
    for (const thread of row.threads.items)
      if (thread.unread.status === "exact")
        settle(
          row.channel_id,
          `${row.channel_id}:${thread.root_id}:summary`,
          watermark,
        );
  }
  let contextRead: Promise<void> | undefined;
  const contextDirty = new Set<string>();
  function selectedContexts(channelIds?: ReadonlySet<string>) {
    const selected = new Map<string, ContextQuery>();
    for (const query of wanted.values()) {
      if (
        !allowed(query.target.channel_id) ||
        (channelIds && !channelIds.has(query.target.channel_id))
      )
        continue;
      const key = contextKey(query.target);
      const previous = selected.get(key);
      selected.set(key, {
        target: query.target,
        message_ids: [
          ...new Set([...(previous?.message_ids ?? []), ...query.message_ids]),
        ],
      });
    }
    return selected;
  }
  function refreshContexts(channelIds?: ReadonlySet<string>): Promise<void> {
    for (const query of wanted.values())
      if (!channelIds || channelIds.has(query.target.channel_id))
        contextDirty.add(query.target.channel_id);
    if (contextRead) return contextRead;
    contextRead = Promise.resolve()
      .then(async () => {
        while (!closed && contextDirty.size) {
          const selected = selectedContexts(new Set(contextDirty));
          contextDirty.clear();
          const queries = [...selected.values()].flatMap((q) =>
            q.message_ids.length
              ? Array.from(
                  { length: Math.ceil(q.message_ids.length / 100) },
                  (_, i) => ({
                    target: q.target,
                    message_ids: q.message_ids.slice(i * 100, (i + 1) * 100),
                  }),
                )
              : [q],
          );
          let batch: ContextQuery[] = [],
            selectors = 0;
          const read = async () => {
            if (!batch.length || !api) return;
            const captured = batch;
            batch = [];
            selectors = 0;
            await schedule(async (signal, generation) => {
              // Released demand must not keep queued work alive.
              const activeQueries = selectedContexts();
              const currentQueries = captured.flatMap((q) => {
                const activeQuery = activeQueries.get(contextKey(q.target));
                if (!activeQuery) return [];
                return [
                  {
                    ...q,
                    message_ids: q.message_ids.filter((id) =>
                      activeQuery.message_ids.includes(id),
                    ),
                  },
                ];
              });
              if (!currentQueries.length || !api) return;
              const watermark = revision;
              const result = await api.contexts(currentQueries, signal);
              current(generation, signal);
              const remaining = selectedContexts();
              currentQueries.forEach((q, i) => {
                const key = contextKey(q.target),
                  state = result.contexts[i];
                const live = remaining.get(key);
                if (!state || !live) return;
                const previous = contexts.get(key);
                if (state.status === "available") {
                  // An omitted or unknown selector cannot settle its presentation.
                  for (const message of state.messages)
                    if (
                      ["read", "not_counted", "unread"].includes(message.status)
                    )
                      settle(
                        q.target.channel_id,
                        `${key}:${message.message_id}`,
                        watermark,
                      );
                  const messages = new Map(
                    previous?.status === "available"
                      ? previous.messages.map((m) => [m.message_id, m])
                      : [],
                  );
                  for (const message of state.messages)
                    messages.set(message.message_id, message);
                  contexts.set(key, {
                    ...state,
                    messages: [...messages.values()].filter((m) =>
                      live.message_ids.includes(m.message_id),
                    ),
                  });
                } else contexts.set(key, state);
              });
              publish();
            });
          };
          for (const q of queries) {
            if (
              batch.length === 20 ||
              selectors + q.message_ids.length > 100 ||
              batch.some((b) => contextKey(b.target) === contextKey(q.target))
            )
              await read();
            batch.push(q);
            selectors += q.message_ids.length;
          }
          await read();
        }
      })
      .finally(() => {
        contextRead = undefined;
      });
    return contextRead;
  }
  async function refreshTargets(ids: string[]) {
    if (!api) return;
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      await schedule(async (signal, generation) => {
        const watermark = revision;
        const result = await api.sidebar({ channel_ids: batch }, signal);
        current(generation, signal);
        const present = new Set(result.channels.map((row) => row.channel_id));
        for (const id of batch) if (!present.has(id)) rows.delete(id);
        for (const row of result.channels) applyRow(row, watermark);
        publish();
      });
    }
  }
  async function refresh() {
    if (closed || !api) return;
    if (traversal) return traversal;
    requested = true;
    traversal = (async () => {
      await ready;
      do {
        traversalDirty = false;
        publish({ status: "loading", error: undefined });
        const generation = epoch;
        const seen = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined,
          total = 0;
        do {
          cursor = await schedule(async (signal, generation) => {
            const watermark = revision;
            const page = await api.sidebar(cursor ? { cursor } : {}, signal);
            current(generation, signal);
            total += page.channels.length;
            if (
              total > MAX_CHANNELS ||
              (total === MAX_CHANNELS && page.next_cursor !== null)
            )
              throw new Error("Sidebar exceeds channel capacity");
            for (const row of page.channels) {
              seen.add(row.channel_id);
              applyRow(row, watermark);
            }
            publish();
            current(generation, signal);
            if (page.next_cursor !== null) {
              if (cursors.has(page.next_cursor))
                throw new Error("Sidebar cursor did not advance");
              cursors.add(page.next_cursor);
            }
            return page.next_cursor ?? undefined;
          });
        } while (cursor);
        // Separate pages have no common snapshot. Check retained absences explicitly.
        await refreshTargets([...rows.keys()].filter((id) => !seen.has(id)));
        await refreshContexts();
        if (!closed && epoch === generation)
          publish({ status: "ready", error: undefined });
      } while (traversalDirty && !closed && requested);
    })()
      .catch(fail)
      .finally(() => {
        traversal = undefined;
        arm();
      });
    return traversal;
  }
  async function flush() {
    if (closed || !api) return;
    if (flushing) return flushing;
    flushing = (async () => {
      await ready;
      await journal.reload();
      // A finite captured batch; new local work schedules another pass.
      const pending = journal.snapshot().pending;
      for (let offset = 0; offset < pending.length; offset += 100) {
        const batch = pending.slice(offset, offset + 100);
        const outcomes = await schedule(async (signal, generation) => {
          const result = await api.write(
            batch.map((p) => p.intent),
            signal,
          );
          current(generation, signal);
          return result;
        }, "write");
        // Admission is batch-atomic: if presentation capacity is full, retain the
        // durable operands and schedule the reads that can free it before retry.
        for (const [id, entry] of applied) {
          const channel = readChannel(entry.read),
            row = rows.get(channel);
          if (
            entry.settled.has(`${channel}:sidebar`) &&
            row?.threads.complete &&
            row.threads.items.every((thread) =>
              entry.settled.has(`${channel}:${thread.root_id}:summary`),
            ) &&
            [...wanted.values()]
              .filter((q) => q.target.channel_id === channel)
              .every((q) =>
                q.message_ids.every((messageId) =>
                  entry.settled.has(`${contextKey(q.target)}:${messageId}`),
                ),
              )
          )
            applied.delete(id);
        }
        const accepted = batch.filter(
          (_, i) => outcomes[i]?.status === "applied",
        );
        if (
          applied.size +
            accepted.filter((read) => !applied.has(read.id)).length >
          MAX_CONTEXTS
        ) {
          for (const entry of applied.values())
            invalidate(readChannel(entry.read));
          for (const read of batch) invalidate(readChannel(read));
          throw new Error(
            "Read presentation capacity reached; reconciliation scheduled",
          );
        }
        // Capture before acknowledgement publishes deletion of pending operands.
        for (const read of accepted)
          if (!applied.has(read.id))
            applied.set(read.id, {
              read,
              revision: ++revision,
              settled: new Set(),
            });
        await journal.acknowledge(batch, outcomes);
        batch.forEach((p, i) => {
          const id =
            p.intent.type === "mark_through"
              ? p.intent.target.channel_id
              : p.intent.channel_id;
          const status = outcomes[i]?.status;
          if (status === "blocked" || status === "invalid") {
            if (operationErrors.size >= MAX_CHANNELS)
              operationErrors.delete(operationErrors.keys().next().value ?? "");
            operationErrors.set(
              id,
              `Read action ${status}; refresh before trying again`,
            );
          } else if (status === "applied") operationErrors.delete(id);
          invalidate(id);
        });
        publish();
        if (outcomes.some((o) => o.status === "unknown"))
          throw new Error("Read acknowledgement unknown; retry available");
      }
      if (sync.writeError) publish({ writeError: undefined });
    })()
      .catch((error) => fail(error, true))
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  }
  function invalidate(channelId: string) {
    if (closed || !api || !requested || !allowed(channelId)) return;
    if (dirty.size >= MAX_CHANNELS && !dirty.has(channelId)) {
      fail(new Error("Sidebar invalidation capacity reached"));
      return;
    }
    dirty.add(channelId);
    drain();
  }
  // One targeted read at a time: channels invalidated while it is in flight
  // share the next one instead of queueing a read per window.
  function drain() {
    if (closed || debounce || draining || !dirty.size || !visible()) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      const ids = [...dirty];
      dirty.clear();
      draining = true;
      void (async () => {
        await refreshTargets(ids);
        await refreshContexts(new Set(ids));
      })()
        .catch(fail)
        .finally(() => {
          draining = false;
          drain();
        });
    }, 250);
  }
  function arm() {
    clearTimeout(periodic);
    if (closed || !requested || !visible()) return;
    periodic = setTimeout(() => {
      periodic = undefined;
      void refresh();
      void flush();
    }, PERIOD_MS);
  }
  function activate() {
    if (!visible()) {
      clearTimeout(periodic);
      periodic = undefined;
      clearTimeout(debounce);
      debounce = undefined;
      return;
    }
    if (requested) {
      void refresh();
      void flush();
    }
  }
  const hostWindow = api && typeof window !== "undefined" ? window : undefined;
  const hostDocument =
    api && typeof document !== "undefined" ? document : undefined;
  hostWindow?.addEventListener("focus", activate);
  hostDocument?.addEventListener("visibilitychange", activate);
  return {
    sync: () => sync,
    revision: () => revision,
    row: (channelId: string) =>
      allowed(channelId) ? rows.get(channelId) : undefined,
    context: (target: ContextQuery["target"]) =>
      allowed(target.channel_id) ? contexts.get(contextKey(target)) : undefined,
    journal,
    covered,
    liveHint: (channelId: string) =>
      allowed(channelId) ? liveHints.get(channelId) : undefined,
    live(channelId: string, hint: Omit<LiveHint, "revision">, unread: boolean) {
      if (!allowed(channelId)) return;
      if (!liveHints.has(channelId) && liveHints.size >= MAX_CHANNELS) {
        fail(new Error("Live presentation capacity reached"));
        return;
      }
      const previous = liveHints.get(channelId),
        next = { ...hint, revision: ++revision };
      liveHints.set(channelId, {
        latest:
          previous && previous.latest.createdAt > hint.createdAt
            ? { ...previous.latest, revision }
            : next,
        ...(unread
          ? { unread: next }
          : previous?.unread
            ? { unread: previous.unread }
            : {}),
      });
      publish();
      invalidate(channelId);
    },
    operationError: (channelId: string) =>
      allowed(channelId) ? operationErrors.get(channelId) : undefined,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Roster changes demand a traversal after their inputs, even mid-refresh.
    ensure(fresh = false) {
      if (fresh && traversal) traversalDirty = true;
      if (!requested) void flush();
      if (!requested || fresh) return refresh();
      return traversal ?? Promise.resolve();
    },
    refresh,
    async retry() {
      await flush();
      await refresh();
    },
    invalidate,
    /** Each consumer owns its selectors until disposal; ingestion never retains demand. */
    retain(query: ContextQuery) {
      if (closed || !api || !allowed(query.target.channel_id))
        return { ready: Promise.resolve(), dispose() {} };
      const selected = selectedContexts();
      const existing = new Set(
        selected.get(contextKey(query.target))?.message_ids ?? [],
      );
      let available =
        MAX_SELECTORS -
        [...selected.values()].reduce((n, q) => n + q.message_ids.length, 0);
      if (wanted.size >= MAX_CONTEXTS)
        throw new Error("Read context capacity reached");
      const message_ids = [...new Set(query.message_ids)].filter((id) => {
        if (existing.has(id)) return true;
        if (available <= 0) return false;
        available--;
        return true;
      });
      if (message_ids.length < new Set(query.message_ids).size)
        throw new Error("Read context capacity reached");
      query = { ...query, message_ids };
      const token = Symbol();
      wanted.set(token, query);
      const ready = refreshContexts(new Set([query.target.channel_id])).catch(
        fail,
      );
      return {
        ready,
        dispose() {
          if (!wanted.delete(token)) return;
          const key = contextKey(query.target),
            remaining = selectedContexts().get(key);
          if (!remaining) contexts.delete(key);
          else {
            const state = contexts.get(key);
            if (state?.status === "available")
              contexts.set(key, {
                ...state,
                messages: state.messages.filter((m) =>
                  remaining.message_ids.includes(m.message_id),
                ),
              });
          }
        },
      };
    },
    async enqueue(
      intents: AnchoredRead[],
      clear: (target: SidebarManualTarget) => boolean,
      valid: () => boolean,
    ) {
      if (!api) throw new Error("Sidebar API unsupported");
      if (!valid()) throw new Error("Reading context changed");
      const token = Symbol();
      saving.set(token, intents);
      publish();
      try {
        const result = await journal.enqueue(intents, clear, valid);
        const inFlight = flushing;
        if (inFlight) void inFlight.then(() => flush());
        else void flush();
        return result;
      } finally {
        saving.delete(token);
        publish();
      }
    },
    stale() {
      if (sync.status !== "unsupported") publish({ status: "stale" });
    },
    reconnect() {
      activate();
    },
    purge() {
      epoch++;
      active.abort();
      active = new AbortController();
      for (const id of rows.keys()) if (!allowed(id)) rows.delete(id);
      for (const id of liveHints.keys()) if (!allowed(id)) liveHints.delete(id);
      for (const [id, entry] of applied)
        if (!allowed(readChannel(entry.read))) applied.delete(id);
      for (const [key, q] of wanted)
        if (!allowed(q.target.channel_id)) {
          wanted.delete(key);
          contexts.delete(contextKey(q.target));
        }
      contextDirty.clear();
      dirty.clear();
      publish({ status: api ? "stale" : "unsupported" });
    },
    clear() {
      epoch++;
      active.abort();
      active = new AbortController();
      rows.clear();
      applied.clear();
      liveHints.clear();
      saving.clear();
      operationErrors.clear();
      contexts.clear();
      wanted.clear();
      contextDirty.clear();
      dirty.clear();
      requested = false;
      traversalDirty = false;
      clearTimeout(periodic);
      clearTimeout(debounce);
      debounce = undefined;
      publish({ status: api ? "idle" : "unsupported", error: undefined });
    },
    dispose() {
      closed = true;
      epoch++;
      active.abort();
      clearTimeout(periodic);
      clearTimeout(debounce);
      hostWindow?.removeEventListener("focus", activate);
      hostDocument?.removeEventListener("visibilitychange", activate);
      listeners.clear();
      rows.clear();
      applied.clear();
      liveHints.clear();
      saving.clear();
      operationErrors.clear();
      contexts.clear();
      wanted.clear();
      journal.dispose();
    },
  };
}
