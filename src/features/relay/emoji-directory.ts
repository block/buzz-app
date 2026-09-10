import { byteSize } from "./budget";
import {
  EMOJI_SET,
  emojiTags,
  emojiMatches,
  messageParts,
  referencedEmoji,
  type CustomEmoji,
} from "./emoji";
import { newer, type RelayEvent } from "./events";
import type { RelayReader } from "./reader";

export type EmojiSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  entries: readonly CustomEmoji[];
  error?: string | undefined;
}>;
const LIMIT = 500;
const MAX_BYTES = 2 * 1024 * 1024;
/** Community-owned latest complete member sets, including empty replacement evidence.
 * No LRU eviction: forgetting a replacement can resurrect a removed shortcode. */
export function createEmojiDirectory(
  reader: RelayReader,
  notify = (listener: () => void) => listener(),
) {
  const sets = new Map<string, { event: RelayEvent; bytes: number }>();
  const listeners = new Set<() => void>();
  let bytes = 0,
    closed = false,
    requested = false,
    limited = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let snapshot: EmojiSnapshot = Object.freeze({
    status: "idle",
    entries: Object.freeze([]),
  });
  function publish(patch: Partial<EmojiSnapshot> = {}) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) notify(listener);
  }
  function accept(incoming: readonly RelayEvent[]) {
    if (closed || limited) return;
    let changed = false;
    for (const event of incoming) {
      if (
        event.kind !== 30030 ||
        event.tags.find(([name]) => name === "d")?.[1] !== EMOJI_SET
      )
        continue;
      const old = sets.get(event.pubkey);
      if (newer(old?.event, event) === old?.event) continue;
      const size = byteSize(event);
      if (
        (!old && sets.size >= LIMIT) ||
        bytes - (old?.bytes ?? 0) + size > MAX_BYTES
      ) {
        limited = true;
        publish({
          status: "error",
          entries: Object.freeze([]),
          error:
            "Community emoji exceeds the catalog budget. Retry after reducing the catalog.",
        });
        return;
      }
      sets.set(event.pubkey, { event, bytes: size });
      bytes += size - (old?.bytes ?? 0);
      changed = true;
    }
    if (!changed) return;
    const winners = new Map<string, { emoji: CustomEmoji; time: number }>();
    for (const { event } of sets.values())
      for (const emoji of emojiTags(event)) {
        const old = winners.get(emoji.shortcode);
        if (
          !old ||
          event.created_at > old.time ||
          (event.created_at === old.time && emoji.url < old.emoji.url)
        )
          winners.set(emoji.shortcode, { emoji, time: event.created_at });
      }
    publish({
      entries: Object.freeze(
        [...winners.values()]
          .map(({ emoji }) => emoji)
          .sort((a, b) => a.shortcode.localeCompare(b.shortcode)),
      ),
    });
  }
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    requested = true;
    if (pending) return pending;
    // Explicit recovery starts a new bounded read after overflow. Never expose a
    // partially retained set as ready; live replacements during this read still win.
    if (limited) {
      sets.clear();
      bytes = 0;
      limited = false;
    }
    const owned = new AbortController();
    controller = owned;
    publish({ status: "loading", error: undefined });
    pending = (async () => {
      try {
        const events = await reader.read(
          [{ kinds: [30030], "#d": [EMOJI_SET], limit: LIMIT }],
          { signal: owned.signal, priority: "background" },
        );
        if (closed || owned.signal.aborted) return;
        accept(events);
        if (closed || owned.signal.aborted || limited) return;
        if (events.length >= LIMIT)
          throw new Error(
            "Community emoji catalog may be incomplete (500-set read limit). Retry after reducing the catalog.",
          );
        publish({ status: "ready", error: undefined });
      } catch (error) {
        if (!closed && !owned.signal.aborted)
          publish({ status: "error", error: String(error) });
      } finally {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      }
    })();
    return pending;
  }
  function ensure() {
    if (snapshot.status === "idle") return refresh();
    return pending ?? Promise.resolve();
  }
  const queries = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
    refresh,
  });
  function clear() {
    controller?.abort();
    controller = undefined;
    pending = undefined;
    sets.clear();
    bytes = 0;
    limited = false;
    publish({ status: "idle", entries: Object.freeze([]), error: undefined });
    // Authority can cancel the initial optional read. Restart once per clear, not per render.
    if (requested && !closed)
      queueMicrotask(() => {
        if (!closed) void ensure();
      });
  }
  return {
    queries,
    accept,
    clear,
    reconnect() {
      if (!requested || closed) return;
      controller?.abort();
      controller = undefined;
      pending = undefined;
      void refresh();
    },
    tags(content: string): string[][] {
      const codes = referencedEmoji(content);
      if (!codes.length) return [];
      if (closed) throw new Error("Community session is closed");
      if (snapshot.status !== "ready") {
        void ensure();
        throw new Error(
          snapshot.status === "error"
            ? `Community emoji unavailable. Retry message preparation or open the emoji picker. ${snapshot.error ?? ""}`
            : "Community emoji is loading. Your draft is kept; try sending again shortly.",
        );
      }
      const used = new Map<string, string>();
      for (const part of messageParts(content)) {
        if (part.startsWith("https://")) continue;
        for (const { emoji } of emojiMatches(part, snapshot.entries))
          used.set(emoji.shortcode, emoji.url);
      }
      return [...used].map(([code, url]) => ["emoji", code, url]);
    },
    dispose() {
      closed = true;
      clear();
      listeners.clear();
    },
  };
}
