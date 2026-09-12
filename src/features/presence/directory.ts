import type { RelayEvent } from "../relay/events";
import type { RelayReader } from "../relay/reader";
import { ReadError } from "../relay/errors";

export type PresenceStatus = "online" | "away" | "offline" | "unknown";
export type PresenceDemand = {
  update(authors: readonly string[]): boolean;
  dispose(): void;
};
export type PresenceQueries = {
  get(author: string): PresenceStatus;
  subscribe(author: string, listener: () => void): () => void;
  demand(): PresenceDemand;
};
type Entry = {
  status: PresenceStatus;
  confirmed?: PresenceStatus;
  live?: PresenceStatus;
  revision: number;
  seen: string[];
  dirty: boolean;
};
const AUTHOR_LIMIT = 256;
const HANDLE_LIMIT = 64;
const MIN_READ_MS = 5000;
const BACKSTOP_MS = 60000;
const validAuthor = (value: string) => /^[0-9a-f]{64}$/.test(value);

/** Volatile, bounded current values. Never feeds the event journal or durable outbox. */
export function createPresenceDirectory({
  reader,
  relayAuthor,
  updateInterests,
  supported,
  notify = (listener) => listener(),
  now = () => Date.now(),
  random = Math.random,
}: {
  reader: RelayReader;
  relayAuthor: string;
  updateInterests(authors: readonly string[]): void;
  supported: boolean;
  notify?: (listener: () => void) => void;
  now?: () => number;
  random?: () => number;
}) {
  let closed = false;
  let visible = true;
  let connected = false;
  let ready = new Set<string>();
  let generation = 0;
  let readAfter = 0;
  let retryAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  let error: string | undefined;
  const entries = new Map<string, Entry>();
  const handles = new Map<object, readonly string[]>();
  const listeners = new Map<string, Set<() => void>>();
  const counters = { reads: 0, received: 0, notifications: 0, limited: 0 };
  const emit = (author: string) => {
    for (const listener of listeners.get(author) ?? []) {
      counters.notifications++;
      notify(listener);
    }
  };
  const set = (author: string, entry: Entry, status: PresenceStatus) => {
    if (entry.status === status) return;
    entry.status = status;
    emit(author);
  };
  const eligible = () =>
    !closed && supported && visible && connected && entries.size > 0;
  function stopRead() {
    generation++;
    if (pending) readAfter = now() + MIN_READ_MS;
    pending?.abort();
    pending = undefined;
    clearTimeout(timer);
    clearTimeout(backstop);
    timer = backstop = undefined;
  }
  function dirty() {
    for (const [author, entry] of entries) {
      entry.dirty = true;
      set(author, entry, "unknown");
    }
  }
  function schedule() {
    if (
      !eligible() ||
      pending ||
      timer ||
      ![...entries].some(([key, value]) => value.dirty && ready.has(key))
    )
      return;
    // Fixed deadline: later input changes the pending set, never postpones this flush.
    timer = setTimeout(
      () => {
        timer = undefined;
        void read();
      },
      Math.max(100, readAfter - now(), retryAt - now()),
    );
  }
  function periodic() {
    clearTimeout(backstop);
    if (!eligible()) return;
    backstop = setTimeout(
      () => {
        backstop = undefined;
        for (const entry of entries.values()) entry.dirty = true;
        schedule();
      },
      BACKSTOP_MS + random() * 5000,
    );
  }
  async function read() {
    if (!eligible() || pending) return;
    const requested = new Map([...entries].filter(([key]) => ready.has(key)));
    if (!requested.size) return;
    const revisions = new Map(
      [...requested].map(([key, value]) => [key, value.revision]),
    );
    const current = generation;
    const owned = new AbortController();
    pending = owned;
    counters.reads++;
    const valid = () =>
      !closed && !owned.signal.aborted && generation === current;
    try {
      const events = await reader.read(
        [
          {
            kinds: [20001],
            authors: [...requested.keys()],
            limit: requested.size,
          },
        ],
        { signal: owned.signal, priority: "background", fresh: true },
      );
      if (!valid()) return;
      const values = new Map<string, PresenceStatus>();
      if (events.length > requested.size)
        throw new Error("Presence snapshot exceeds requested subjects");
      for (const event of events) {
        const subjects = event.tags.filter(([name]) => name === "p");
        const author = subjects[0]?.[1];
        const status = parsePresenceStatus(event);
        if (
          event.kind !== 20001 ||
          event.pubkey !== relayAuthor ||
          subjects.length !== 1 ||
          subjects[0]?.length !== 2 ||
          !author ||
          !requested.has(author) ||
          values.has(author) ||
          !status
        )
          throw new Error("Invalid relay presence snapshot");
        values.set(author, status);
      }
      error = undefined;
      retryAt = 0;
      for (const [author, entry] of requested) {
        if (entries.get(author) !== entry) continue; // Removed/re-added is another lifetime.
        const status = values.get(author) ?? "offline";
        if (entry.revision !== revisions.get(author) && entry.live !== status) {
          entry.dirty = true;
          set(author, entry, "unknown");
        } else {
          entry.confirmed = status;
          entry.dirty = false;
          set(author, entry, status);
        }
      }
    } catch (failure) {
      if (!valid()) return;
      error =
        failure instanceof Error ? failure.message : "Presence unavailable";
      retryAt =
        now() +
        Math.max(
          BACKSTOP_MS,
          failure instanceof ReadError ? (failure.retryAfterMs ?? 0) : 0,
        );
      dirty();
    } finally {
      if (pending === owned) {
        // Start the cooldown after the whole shared reader/broker operation, not
        // enqueue time: admission delay must not compress actual relay reads.
        readAfter = now() + MIN_READ_MS;
        pending = undefined;
        periodic();
        schedule();
      }
    }
  }
  function interests() {
    const wanted = new Set([...handles.values()].flat());
    for (const [author] of entries)
      if (!wanted.has(author)) {
        entries.delete(author);
        emit(author);
      }
    for (const author of wanted)
      if (!entries.has(author))
        entries.set(author, {
          status: "unknown",
          revision: 0,
          seen: [],
          dirty: true,
        });
    if (!entries.size) stopRead();
    if (!closed && supported)
      updateInterests(visible ? [...entries.keys()].sort() : []);
    schedule();
  }
  const queries: PresenceQueries = Object.freeze({
    get: (author: string) => entries.get(author)?.status ?? "unknown",
    subscribe(author: string, listener: () => void) {
      if (closed) return () => {};
      let selected = listeners.get(author);
      if (!selected) {
        selected = new Set();
        listeners.set(author, selected);
      }
      selected.add(listener);
      return () => {
        selected.delete(listener);
        if (!selected.size && listeners.get(author) === selected)
          listeners.delete(author);
      };
    },
    demand() {
      const token = {};
      let disposed = closed || handles.size >= HANDLE_LIMIT;
      if (disposed) counters.limited++;
      else handles.set(token, []);
      return {
        update(input) {
          if (disposed || closed) return false;
          const authors = [...new Set(input)];
          const union = new Set(
            [...handles].flatMap(([key, value]) =>
              key === token ? [] : [...value],
            ),
          );
          for (const author of authors) union.add(author);
          const allowed =
            authors.length <= AUTHOR_LIMIT &&
            authors.every(validAuthor) &&
            union.size <= AUTHOR_LIMIT;
          if (!allowed) counters.limited++;
          handles.set(token, allowed ? authors : []);
          interests();
          return allowed;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          handles.delete(token);
          interests();
        },
      };
    },
  });
  return {
    queries,
    receive(events: readonly RelayEvent[]) {
      if (!eligible()) return;
      for (const event of events) {
        const entry = entries.get(event.pubkey);
        const status = parsePresenceStatus(event);
        if (
          event.kind !== 20001 ||
          !entry ||
          !status ||
          entry.seen.includes(event.id)
        )
          continue;
        counters.received++;
        entry.seen.push(event.id);
        if (entry.seen.length > 8) entry.seen.shift();
        entry.live = status;
        entry.revision++;
        if (entry.confirmed !== status || entry.status === "unknown") {
          entry.dirty = true;
          set(event.pubkey, entry, "unknown");
        }
      }
      schedule();
    },
    route(state: {
      status: string;
      authors: readonly string[];
      error?: string | undefined;
    }) {
      if (closed) return;
      ready = new Set(state.status === "ready" ? state.authors : []);
      if (state.status === "error") {
        error = state.error ?? "Presence subscription unavailable";
        stopRead();
        dirty();
      }
      schedule();
    },
    connection(active: boolean) {
      if (closed || connected === active) return;
      connected = active;
      stopRead();
      ready.clear();
      dirty();
    },
    visibility(active: boolean) {
      if (closed || visible === active) return;
      visible = active;
      stopRead();
      ready.clear();
      dirty();
      interests();
    },
    clear() {
      if (closed) return;
      stopRead();
      for (const entry of entries.values()) {
        delete entry.confirmed;
        delete entry.live;
        entry.seen = [];
      }
      dirty();
      schedule();
    },
    dispose() {
      closed = true;
      stopRead();
      dirty();
      entries.clear();
      handles.clear();
      listeners.clear();
    },
    diagnostics: () => ({
      ...counters,
      authors: entries.size,
      handles: handles.size,
      pending: !!pending,
      error,
    }),
  };
}
/** Bare status plus legacy JSON; never treat unknown content as Online. */
export function parsePresenceStatus(
  event: Pick<RelayEvent, "content">,
): Exclude<PresenceStatus, "unknown"> | undefined {
  try {
    if (event.content.length > 2048) return;
    const status: unknown = ["online", "away", "offline"].includes(
      event.content,
    )
      ? event.content
      : JSON.parse(event.content)?.status;
    if (status === "online" || status === "away" || status === "offline")
      return status;
  } catch {
    /* Invalid presence is not an Offline signal. */
  }
}
