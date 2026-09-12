import type { RelayEvent } from "./events";
import { threadReference } from "./thread-reference";

const TTL = 8_000;
const SUPPRESS = 2_000;
const CAPACITY = 1024;
export type TypingEntry = Readonly<{
  channelId: string;
  threadRootId?: string;
  pubkey: string;
}>;
type Record = {
  entry: TypingEntry;
  typingAt: number;
  messageAt: number;
  expires: number;
  suppress: number;
  retire: number;
};

/** Receive-only ephemeral projection. Input is verified by the existing host
 * transport; identity is the signer, never a display name or an untrusted p tag.
 * No retained event payloads, reads, persistence, or per-consumer timers. */
export function createTyping(
  viewer: string,
  canAccess: (channelId: string) => boolean,
  notify: (listener: () => void) => void,
) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = new Map<string, Record>();
  const listeners = new Set<() => void>();
  let snapshot: readonly TypingEntry[] = Object.freeze([]);
  function publish() {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    let nextWake = Infinity;
    const next: TypingEntry[] = [];
    for (const [key, record] of records) {
      if (record.retire <= now) {
        records.delete(key);
        continue;
      }
      nextWake = Math.min(nextWake, record.retire);
      if (record.expires > now) {
        next.push(record.entry);
        nextWake = Math.min(nextWake, record.expires);
      }
    }
    if (!closed && nextWake < Infinity)
      timer = setTimeout(publish, nextWake - now);
    if (
      next.length === snapshot.length &&
      next.every((e, i) => e === snapshot[i])
    )
      return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function accept(events: readonly RelayEvent[], live = false) {
    if (closed) return;
    const now = Date.now();
    // Prune before admission; at capacity drop new keys, never evict suppression
    // evidence to admit an older pulse. All records retire within a bounded TTL.
    for (const [key, record] of records)
      if (record.retire <= now) records.delete(key);
    // Completion wins independent of batch ordering (including equal seconds).
    for (const event of [...events].sort(
      (a, b) => Number(a.kind === 20002) - Number(b.kind === 20002),
    )) {
      const typing = event.kind === 20002;
      if ((!typing && ![9, 40002].includes(event.kind)) || (typing && !live))
        continue;
      if (event.pubkey === viewer || !/^[0-9a-f]{64}$/.test(event.pubkey))
        continue;
      const at = event.created_at * 1000;
      if (
        !Number.isSafeInteger(event.created_at) ||
        at > now ||
        at + TTL <= now
      )
        continue;
      const channels = event.tags.filter(([name]) => name === "h");
      const channelId = channels[0]?.[1];
      if (
        channels.length !== 1 ||
        !channelId ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(channelId) ||
        !canAccess(channelId)
      )
        continue;
      const refs = event.tags.filter(([name]) => name === "e");
      // Pulses require an unambiguous canonical scope. Content uses the same
      // threadReference semantics as folding, including non-thread references.
      if (
        typing &&
        refs.length &&
        (refs.length > 2 ||
          refs.some(
            (tag) =>
              !/^[0-9a-f]{64}$/i.test(tag[1] ?? "") ||
              !["root", "reply"].includes(tag[3] ?? ""),
          ) ||
          refs.filter((tag) => tag[3] === "reply").length !== 1 ||
          refs.filter((tag) => tag[3] === "root").length > 1)
      )
        continue;
      const threadRootId = threadReference(event)?.rootId;
      const key = `${channelId}:${threadRootId ?? ""}:${event.pubkey}`;
      let record = records.get(key);
      if (!record) {
        if (records.size >= CAPACITY) continue;
        record = {
          entry: Object.freeze({
            channelId,
            ...(threadRootId ? { threadRootId } : {}),
            pubkey: event.pubkey,
          }),
          typingAt: -1,
          messageAt: -1,
          expires: 0,
          suppress: 0,
          retire: 0,
        };
        records.set(key, record);
      }
      if (typing) {
        if (
          at <= record.typingAt ||
          at <= record.messageAt ||
          record.suppress > now
        )
          continue;
        record.typingAt = at;
        record.expires = at + TTL;
      } else {
        if (at <= record.messageAt) continue;
        record.messageAt = at;
        if (at >= record.typingAt) {
          record.expires = 0;
          record.suppress = now + SUPPRESS;
        }
      }
      record.retire = Math.max(record.retire, at + TTL, record.suppress);
    }
    publish();
  }
  function clear() {
    records.clear();
    publish();
  }
  return {
    capability: Object.freeze({
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    accept,
    clear,
    dispose() {
      closed = true;
      clear();
      listeners.clear();
    },
  };
}
