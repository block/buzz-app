import type { EventTemplate } from "nostr-tools";
import { eventDto, newer, type RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export const USER_STATUS_KIND = 30315;
export const STATUS_TEXT_LIMIT = 100;
export type UserStatus = Readonly<{
  userId: string;
  text: string;
  emoji: string;
  updatedAt: number;
  expiresAt?: number;
}>;
export type StatusInput = Pick<UserStatus, "text" | "emoji" | "expiresAt">;

function parse(event: RelayEvent): UserStatus | undefined {
  if (
    event.kind !== USER_STATUS_KIND ||
    event.tags.filter(([key]) => key === "d").length !== 1 ||
    !event.tags.some(([key, value]) => key === "d" && value === "general") ||
    event.tags.some(([key]) => key === "h")
  )
    return;
  const expiration = event.tags.find(([key]) => key === "expiration")?.[1];
  const expiresAt = expiration === undefined ? undefined : Number(expiration);
  if (
    expiresAt !== undefined &&
    (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
  )
    return;
  return Object.freeze({
    userId: event.pubkey,
    text: event.content.trim(),
    emoji: event.tags.find(([key]) => key === "emoji")?.[1]?.trim() ?? "",
    updatedAt: event.created_at,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

/** One community session owns replacement evidence, including clears and expired values.
 * Never discard a tombstone while retaining older values for the same author. */
export function createUserStatuses(
  reader: RelayReader,
  viewer?: string,
  writer?: RelayWriter,
  notify = (listener: () => void) => listener(),
) {
  const records = new Map<string, { event: RelayEvent; status: UserStatus }>();
  const watched = new Map<string, number>();
  const loaded = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, UserStatus> = new Map();
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let scheduled = false;
  let closed = false;
  let saving = false;
  let error: string | undefined;
  function publish() {
    clearTimeout(timer);
    const now = Date.now() / 1000;
    let deadline = Infinity;
    const next = new Map<string, UserStatus>();
    for (const [id, { status }] of records) {
      if (
        (!status.text && !status.emoji) ||
        (status.expiresAt !== undefined && status.expiresAt <= now)
      )
        continue;
      next.set(id, status);
      if (status.expiresAt !== undefined)
        deadline = Math.min(deadline, status.expiresAt);
    }
    if (deadline !== Infinity)
      timer = setTimeout(
        publish,
        Math.min(2147483647, Math.max(1, deadline * 1000 - Date.now())),
      );
    if (
      next.size === snapshot.size &&
      [...next].every(([id, value]) => snapshot.get(id) === value)
    )
      return;
    snapshot = next;
    for (const listener of listeners) notify(listener);
  }
  function accept(events: readonly RelayEvent[]) {
    if (closed) return;
    for (const event of events) {
      // Live traffic for offscreen people need not grow this session's cache.
      if (
        !watched.has(event.pubkey) &&
        event.pubkey !== viewer &&
        !records.has(event.pubkey)
      )
        continue;
      const status = parse(event);
      if (!status) continue;
      const old = records.get(event.pubkey);
      if (newer(old?.event, event) === old?.event) continue;
      records.set(event.pubkey, { event, status });
    }
    publish();
  }
  async function load() {
    if (closed) return;
    if (pending) return pending;
    const signal = controller.signal;
    pending = (async () => {
      const missing = [...watched.keys()].filter((id) => !loaded.has(id));
      for (let offset = 0; offset < missing.length; offset += 100) {
        const authors = missing.slice(offset, offset + 100);
        const events = await reader.read(
          [
            {
              kinds: [USER_STATUS_KIND],
              "#d": ["general"],
              authors,
              limit: authors.length,
            },
          ],
          { signal, priority: "background" },
        );
        if (closed || signal.aborted) return;
        accept(events.filter((event) => authors.includes(event.pubkey)));
        for (const id of authors) loaded.add(id);
      }
      error = undefined;
    })()
      .catch((reason: unknown) => {
        if (!signal.aborted) error = String(reason);
      })
      .finally(() => {
        if (signal.aborted) return;
        pending = undefined;
      });
    return pending;
  }
  function schedule() {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void load().then(() => {
        if (
          !closed &&
          !error &&
          [...watched.keys()].some((id) => !loaded.has(id))
        )
          schedule();
      });
    });
  }
  function watch(ids: readonly string[]) {
    const unique = [...new Set(ids)].filter((id) => /^[0-9a-f]{64}$/.test(id));
    for (const id of unique) watched.set(id, (watched.get(id) ?? 0) + 1);
    schedule();
    return () => {
      for (const id of unique) {
        const count = (watched.get(id) ?? 1) - 1;
        if (count) watched.set(id, count);
        else {
          watched.delete(id);
          // Evict the whole coordinate, never only its latest replacement evidence.
          if (id !== viewer) {
            loaded.delete(id);
            records.delete(id);
          }
        }
      }
      publish();
    };
  }
  async function save(input: StatusInput) {
    if (
      closed ||
      !viewer ||
      !writer ||
      (writer.kinds && !writer.kinds.includes(USER_STATUS_KIND))
    )
      throw new Error("Status updates are unavailable in this community.");
    if (saving) throw new Error("A status update is already in progress.");
    const text = input.text.trim();
    const emoji = input.emoji.trim();
    if (
      text.length > STATUS_TEXT_LIMIT ||
      emoji.length > 100 ||
      /[\r\n]/.test(text + emoji)
    )
      throw new Error("Keep your status to one short line (100 characters).");
    const expiresAt = text || emoji ? input.expiresAt : undefined;
    if (
      expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000)
    )
      throw new Error("Choose an expiration in the future.");
    saving = true;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(12000),
    ]);
    try {
      // Fetch current own replacement before signing, including on a fresh installation.
      const current = await reader.read(
        [
          {
            kinds: [USER_STATUS_KIND],
            "#d": ["general"],
            authors: [viewer],
            limit: 1,
          },
        ],
        { signal, fresh: true },
      );
      accept(current.filter((event) => event.pubkey === viewer));
      signal.throwIfAborted();
      const template: EventTemplate = {
        kind: USER_STATUS_KIND,
        created_at: Math.max(
          Math.floor(Date.now() / 1000),
          (records.get(viewer)?.event.created_at ?? 0) + 1,
        ),
        content: text,
        tags: [
          ["d", "general"],
          ...(emoji ? [["emoji", emoji]] : []),
          ...(expiresAt === undefined
            ? []
            : [["expiration", String(expiresAt)]]),
        ],
      };
      const event = eventDto(await writer.sign(template, signal));
      if (
        event.pubkey !== viewer ||
        event.kind !== template.kind ||
        event.created_at !== template.created_at ||
        event.content !== template.content ||
        JSON.stringify(event.tags) !== JSON.stringify(template.tags)
      )
        throw new Error("The signed status did not match your update.");
      signal.throwIfAborted();
      await writer.publish(event, signal);
      signal.throwIfAborted();
      accept([event]);
    } finally {
      saving = false;
    }
  }
  function clear() {
    controller.abort();
    controller = new AbortController();
    pending = undefined;
    loaded.clear();
    records.clear();
    publish();
    schedule();
  }
  const queries = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch,
    async current(userId: string) {
      if (closed) throw new Error("Community session is closed.");
      const signal = controller.signal;
      const events = await reader.read(
        [
          {
            kinds: [USER_STATUS_KIND],
            "#d": ["general"],
            authors: [userId],
            limit: 1,
          },
        ],
        { signal, fresh: true },
      );
      signal.throwIfAborted();
      accept(events.filter((event) => event.pubkey === userId));
      return snapshot.get(userId);
    },
    save,
    writable:
      !!viewer &&
      !!writer &&
      (!writer.kinds || writer.kinds.includes(USER_STATUS_KIND)),
    refresh() {
      loaded.clear();
      schedule();
    },
  });
  return {
    queries,
    accept,
    clear,
    reconnect() {
      controller.abort();
      controller = new AbortController();
      pending = undefined;
      loaded.clear();
      schedule();
    },
    dispose() {
      closed = true;
      clear();
      clearTimeout(timer);
      listeners.clear();
      watched.clear();
    },
  };
}
export type UserStatuses = ReturnType<typeof createUserStatuses>["queries"];
