import { retryRead } from "./read-retry";
import type { UploadedAttachment } from "./attachments";
import { byteSize } from "./budget";
import {
  EMOJI_SET_KIND,
  emojiSetD,
  emojiSetPart,
  emojiTags,
  emojiMatches,
  linkPart,
  messageParts,
  normalizeShortcode,
  referencedEmoji,
  type CustomEmoji,
} from "./emoji";
import { eventDto, newer, type ReadFilter, type RelayEvent } from "./events";
import type { Priority, ReadOptions, RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export type EmojiSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  entries: readonly CustomEmoji[];
  /** The viewer's own latest set: the only one this client may republish. */
  mine: readonly CustomEmoji[];
  error?: string | undefined;
}>;
export type EmojiAuthoring = Readonly<{
  writer: RelayWriter;
  upload?(file: File, signal: AbortSignal): Promise<UploadedAttachment>;
}>;
/** Events per catalog page: 100 full parts stay well inside a native read's
 * 16 MiB response. */
export const EMOJI_PAGE = 100;
/** Sized for a 100k-emoji community (~150 bytes per entry) plus headroom. */
const MAX_SETS = 5_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 100;
/** Tag bytes one authored part may hold (~450 emoji). Small parts keep each
 * edit and live update cheap, far below the relay's 512 KiB frame. */
export const EMOJI_PART_BYTES = 60 * 1024;
const partOf = (event: RelayEvent) =>
  event.kind === EMOJI_SET_KIND
    ? emojiSetPart(event.tags.find(([name]) => name === "d")?.[1])
    : undefined;
const parsed = new WeakMap<RelayEvent, readonly CustomEmoji[]>();
/** Parse each retained event once, not on every catalog change. */
function entriesOf(event: RelayEvent) {
  let entries = parsed.get(event);
  if (!entries) {
    entries = emojiTags(event);
    parsed.set(event, entries);
  }
  return entries;
}
const ascii = (a: CustomEmoji, b: CustomEmoji) =>
  a.shortcode < b.shortcode ? -1 : a.shortcode > b.shortcode ? 1 : 0;
/** Reads every page of `filter`, newest first. `until` is inclusive, so a page
 * repeats its boundary second and progress is judged by new event ids; a full
 * page of one second cannot advance and reports the read as incomplete. */
async function readPages(
  read: (filter: ReadFilter) => Promise<readonly RelayEvent[]>,
  filter: ReadFilter,
  page: (events: readonly RelayEvent[]) => boolean,
): Promise<{ complete: boolean }> {
  const seen = new Set<string>();
  let until: number | undefined;
  for (let count = 0; count < MAX_PAGES; count++) {
    const events = await read(
      until === undefined ? filter : { ...filter, until },
    );
    if (!page(events)) return { complete: true };
    let fresh = false;
    for (const event of events)
      if (!seen.has(event.id)) {
        seen.add(event.id);
        fresh = true;
      }
    if (events.length < filter.limit) return { complete: true };
    if (!fresh) return { complete: false };
    until = Math.min(...events.map((event) => event.created_at));
  }
  return { complete: false };
}
/** Community-owned latest complete member set parts, including empty replacement evidence.
 * No LRU eviction: forgetting a replacement can resurrect a removed shortcode. */
export function createEmojiDirectory(
  reader: RelayReader,
  notify = (listener: () => void) => listener(),
  viewer?: string,
  authoring?: EmojiAuthoring,
) {
  const sets = new Map<
    string,
    { event: RelayEvent; part: number; bytes: number }
  >();
  const listeners = new Set<() => void>();
  let bytes = 0,
    closed = false,
    requested = false,
    limited = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let pendingPriority: Priority = "background";
  const lifetime = new AbortController();
  let editing: Promise<unknown> = Promise.resolve();
  let snapshot: EmojiSnapshot = Object.freeze({
    status: "idle",
    entries: Object.freeze([]),
    mine: Object.freeze([]),
  });
  function publish(patch: Partial<EmojiSnapshot> = {}) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) notify(listener);
  }
  function accept(incoming: readonly RelayEvent[]) {
    if (closed || limited) return;
    let changed = false;
    for (const event of incoming) {
      const part = partOf(event);
      if (part === undefined) continue;
      const key = `${event.pubkey}/${part}`;
      const old = sets.get(key);
      if (newer(old?.event, event) === old?.event) continue;
      const size = byteSize(event);
      if (
        (!old && sets.size >= MAX_SETS) ||
        bytes - (old?.bytes ?? 0) + size > MAX_BYTES
      ) {
        limited = true;
        publish({
          status: "error",
          entries: Object.freeze([]),
          mine: Object.freeze([]),
          error:
            "Community emoji exceeds the catalog budget. Retry after reducing the catalog.",
        });
        return;
      }
      sets.set(key, { event, part, bytes: size });
      bytes += size - (old?.bytes ?? 0);
      changed = true;
    }
    if (!changed) return;
    publish({
      entries: Object.freeze(union([...sets.values()]).sort(ascii)),
      mine: viewer ? Object.freeze(union(own())) : snapshot.mine,
    });
  }
  /** Newer parts win a shortcode; same-second ties take the smaller URL. */
  function union(parts: readonly { event: RelayEvent }[]) {
    const winners = new Map<string, { emoji: CustomEmoji; time: number }>();
    for (const { event } of parts)
      for (const emoji of entriesOf(event)) {
        const old = winners.get(emoji.shortcode);
        if (
          !old ||
          event.created_at > old.time ||
          (event.created_at === old.time && emoji.url < old.emoji.url)
        )
          winners.set(emoji.shortcode, { emoji, time: event.created_at });
      }
    return [...winners.values()].map(({ emoji }) => emoji);
  }
  /** The viewer's retained parts in part order. */
  function own() {
    return [...sets.values()]
      .filter(({ event }) => event.pubkey === viewer)
      .sort((a, b) => a.part - b.part);
  }
  /** Passive demand yields to other reads. An explicit retry runs in the
   * foreground and supersedes a passive load, which can spend its whole deadline
   * queued behind background profile reads without reaching the relay. */
  function load(priority: Priority): Promise<void> {
    if (closed) return Promise.resolve();
    requested = true;
    if (pending && (priority === "background" || pendingPriority === priority))
      return pending;
    controller?.abort();
    pendingPriority = priority;
    // Explicit recovery starts a new bounded read after overflow. Never expose a
    // partially retained set as ready; live replacements during this read still win.
    if (limited) {
      sets.clear();
      bytes = 0;
      limited = false;
    }
    const owned = new AbortController();
    controller = owned;
    // A loaded catalog stays ready while it revalidates: sends keep their tags
    // and pickers their custom category. Only a cold catalog shows loading.
    if (snapshot.status !== "ready")
      publish({ status: "loading", error: undefined });
    else if (snapshot.error) publish({ error: undefined });
    pending = (async () => {
      try {
        // Parts carry their own `d`, so read the kind and keep Buzz parts.
        const { complete } = await readPages(
          (filter) =>
            retryRead(
              (signal) => reader.read([filter], { signal, priority }),
              owned.signal,
            ),
          { kinds: [EMOJI_SET_KIND], limit: EMOJI_PAGE },
          (events) => {
            if (closed || owned.signal.aborted) return false;
            accept(events);
            return !closed && !owned.signal.aborted && !limited;
          },
        );
        if (closed || owned.signal.aborted || limited) return;
        // Pages arrive newest first, so a stalled read still holds the latest
        // parts and resolves their shortcodes.
        publish({
          status: "ready",
          error: complete
            ? undefined
            : "Community emoji catalog may be incomplete. Retry after reducing the catalog.",
        });
      } catch (error) {
        // A failed revalidation keeps the loaded catalog, with its error.
        if (!closed && !owned.signal.aborted)
          publish({
            status: snapshot.status === "ready" ? "ready" : "error",
            error: String(error),
          });
      } finally {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      }
    })();
    return pending;
  }
  const refresh = () => load("foreground");
  function ensure(priority: Priority = "background") {
    // Active controls may remount on every keystroke. Promote passive demand
    // once; after an active failure, keep the error and explicit Retry stable.
    if (
      !limited &&
      (snapshot.status === "idle" ||
        (priority === "foreground" &&
          pendingPriority === "background" &&
          snapshot.status !== "ready"))
    )
      return load(priority);
    return pending ?? Promise.resolve();
  }
  /** Read-modify-write of the viewer's own parts; an absent URL removes the
   * shortcode. Only the parts that change are republished. */
  async function publishEdit(
    writer: RelayWriter,
    shortcode: string,
    url?: string,
  ): Promise<string> {
    const failure =
      url === undefined ? "Failed to remove emoji." : "Failed to add emoji.";
    if (!viewer) throw new Error(failure);
    // Covers reading every own part (a 100k-emoji owner pages ~15 MB) and
    // republishing the touched ones.
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([lifetime.signal, timeout]);
    const options: ReadOptions = { signal, fresh: true };
    try {
      // A capped or refused catalog must not hide the latest own parts from replacement.
      const current = new Map<number, RelayEvent>();
      for (const { event, part } of own()) current.set(part, event);
      const fetched: RelayEvent[] = [];
      const { complete } = await readPages(
        (filter) => reader.read([filter], options),
        { kinds: [EMOJI_SET_KIND], authors: [viewer], limit: EMOJI_PAGE },
        (events) => {
          signal.throwIfAborted();
          fetched.push(...events);
          return true;
        },
      );
      // Without every part, a write could duplicate or strand a shortcode.
      if (!complete) throw new Error(failure);
      accept(fetched);
      for (const event of fetched) {
        const part = partOf(event);
        if (event.pubkey === viewer && part !== undefined)
          current.set(part, newer(current.get(part), event));
      }
      const parts = new Map(
        [...current].map(([part, event]) => [part, entriesOf(event)] as const),
      );
      const touched = new Map<number, CustomEmoji[]>();
      // A legacy client may have left one shortcode in several parts.
      for (const [part, entries] of parts)
        if (entries.some((entry) => entry.shortcode === shortcode))
          touched.set(
            part,
            entries.filter((entry) => entry.shortcode !== shortcode),
          );
      if (url === undefined && !touched.size) return shortcode;
      let target: number | undefined;
      if (url !== undefined) {
        const fits = (entries: readonly CustomEmoji[]) =>
          byteSize(entries.map((e) => ["emoji", e.shortcode, e.url])) +
            byteSize(["emoji", shortcode, url]) <=
          EMOJI_PART_BYTES;
        // Prefer a part that held the shortcode, then the first with room.
        const ascending = (keys: Iterable<number>) =>
          [...keys].sort((a, b) => a - b);
        target =
          [...ascending(touched.keys()), ...ascending(parts.keys())].find(
            (part) => fits(touched.get(part) ?? parts.get(part) ?? []),
          ) ?? (parts.size ? Math.max(...parts.keys()) + 1 : 0);
        touched.set(target, [
          ...(touched.get(target) ?? parts.get(target) ?? []),
          { shortcode, url },
        ]);
      }
      // Publish the part gaining the shortcode first, so it never disappears.
      const order = [...touched.keys()].sort((a, b) =>
        a === target ? -1 : b === target ? 1 : a - b,
      );
      for (const part of order) {
        const entries = touched.get(part) ?? [];
        const template = {
          kind: EMOJI_SET_KIND,
          created_at: Math.max(
            Math.floor(Date.now() / 1000),
            (current.get(part)?.created_at ?? 0) + 1,
          ),
          content: "",
          tags: [
            ["d", emojiSetD(part)],
            ...entries.map((entry) => ["emoji", entry.shortcode, entry.url]),
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
          throw new Error(failure);
        signal.throwIfAborted();
        await writer.publish(event, signal);
        signal.throwIfAborted();
        accept([event]);
      }
      return shortcode;
    } catch {
      throw new Error(
        timeout.aborted
          ? url === undefined
            ? "Timed out while removing emoji."
            : "Timed out while adding emoji."
          : failure,
      );
    }
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
    ...(authoring
      ? {
          /** Removes only from the viewer's set; absent or invalid names are no-ops. */
          remove(name: string): Promise<void> {
            const shortcode = normalizeShortcode(name);
            if (!shortcode) return Promise.resolve();
            if (closed)
              return Promise.reject(new Error("Failed to remove emoji."));
            const run = editing.then(() =>
              publishEdit(authoring.writer, shortcode),
            );
            editing = run.catch(() => undefined);
            return run.then(() => undefined);
          },
        }
      : {}),
    ...(authoring?.upload
      ? {
          upload: authoring.upload,
          /** Adds or replaces one shortcode; returns the normalized shortcode. */
          add(name: string, url: string): Promise<string> {
            const shortcode = normalizeShortcode(name);
            if (!shortcode)
              return Promise.reject(
                new Error(
                  "Invalid emoji name. Use letters, numbers, hyphen, or underscore.",
                ),
              );
            if (closed)
              return Promise.reject(new Error("Failed to add emoji."));
            // Serialize edits so a stale relay read cannot undo an earlier edit.
            const run = editing.then(() =>
              publishEdit(authoring.writer, shortcode, url),
            );
            editing = run.catch(() => undefined);
            return run;
          },
        }
      : {}),
  });
  function clear() {
    controller?.abort();
    controller = undefined;
    pending = undefined;
    sets.clear();
    bytes = 0;
    limited = false;
    publish({
      status: "idle",
      entries: Object.freeze([]),
      mine: Object.freeze([]),
      error: undefined,
    });
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
      void load("background");
    },
    tags(content: string): string[][] {
      const codes = referencedEmoji(content);
      if (!codes.length) return [];
      if (closed) throw new Error("Community session is closed");
      if (snapshot.status !== "ready") {
        // A send retries a cold failure, but passive mounts cannot repeat
        // reads; refresh() shares a pending one. Overflow would repeat on every
        // read, so it waits for an explicit retry. The composer keeps this text
        // after the read settles, so it must not claim the read is still running.
        void (snapshot.status === "error" && !limited ? refresh() : ensure());
        throw new Error(
          snapshot.status === "error"
            ? `Community emoji unavailable. Retry message preparation or open the emoji picker. ${snapshot.error ?? ""}`
            : "Community emoji isn't ready. Your draft is kept; try sending again shortly.",
        );
      }
      const used = new Map<string, string>();
      for (const part of messageParts(content)) {
        if (linkPart(part)) continue;
        for (const { emoji } of emojiMatches(part, snapshot.entries))
          used.set(emoji.shortcode, emoji.url);
      }
      return [...used].map(([code, url]) => ["emoji", code, url]);
    },
    dispose() {
      closed = true;
      lifetime.abort();
      clear();
      listeners.clear();
    },
  };
}
