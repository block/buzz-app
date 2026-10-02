import {
  createEventVerifier,
  eventDto,
  type RelayEvent,
} from "../relay/events";
import { ACTIVITY_HISTORY_AGE_MS, OBSERVER_KIND } from "./observer";

export const HISTORY_RECORD_LIMIT = 200;
export const HISTORY_BYTE_LIMIT = 2 * 1024 * 1024;
export type SavedActivity = Readonly<{ event: RelayEvent; receivedAt: number }>;
type Journal = { revision: number; records: SavedActivity[] };
export interface ActivityHistory {
  load(): Promise<readonly SavedActivity[]>;
  append(record: SavedActivity): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

/** Copy only verified ciphertext wire fields. Storage is not an authority. */
export function retainedActivity(
  raw: unknown,
  viewer: string,
  now = Date.now(),
  verify = eventDto,
): SavedActivity[] {
  if (!Array.isArray(raw)) return [];
  const records = new Map<string, SavedActivity>();
  for (const item of raw.slice(-HISTORY_RECORD_LIMIT)) {
    try {
      if (
        !Number.isSafeInteger(item?.receivedAt) ||
        item.receivedAt > now ||
        now - item.receivedAt >= ACTIVITY_HISTORY_AGE_MS
      )
        continue;
      const event = verify(item.event);
      const exact = (name: string, value: string) => {
        const tags = event.tags.filter((tag) => tag[0] === name);
        return (
          tags.length === 1 && tags[0]?.length === 2 && tags[0][1] === value
        );
      };
      if (
        event.kind !== OBSERVER_KIND ||
        !exact("p", viewer) ||
        !exact("agent", event.pubkey) ||
        !exact("frame", "telemetry") ||
        event.content.length < 132 ||
        event.content.length > 87472 ||
        event.created_at * 1000 > now + 300_000 ||
        now - event.created_at * 1000 >= ACTIVITY_HISTORY_AGE_MS
      )
        continue;
      records.set(event.id, { event, receivedAt: item.receivedAt });
    } catch {
      /* Invalid local entries are discarded, never rendered. */
    }
  }
  const result = [...records.values()].sort(
    (a, b) => a.receivedAt - b.receivedAt,
  );
  let bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  while (bytes > HISTORY_BYTE_LIMIT && result.length) {
    const first = result.shift();
    bytes -= new TextEncoder().encode(JSON.stringify(first)).length + 1;
  }
  return result;
}

/** One atomic partition per account/community. Clear advances a durable fence so
 * an older window cannot write its pre-clear journal back over the deletion. */
export function browserActivityHistory(
  scope: string,
  viewer: string,
): ActivityHistory {
  const partition = JSON.stringify([scope, viewer]);
  const verify = createEventVerifier();
  let revision: number | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let database: Promise<IDBDatabase> | undefined;
  let pending: { records: SavedActivity[]; done: Promise<void> } | undefined;
  function open() {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined")
        return reject(new Error("Local activity storage unavailable"));
      const request = indexedDB.open("buzz-agent-activity-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("partitions");
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Local activity storage blocked"));
    });
    return database;
  }
  function update(change: (current: Journal) => Journal) {
    if (closed) return Promise.reject(new Error("Activity history closed"));
    const operation = queue
      .catch(() => {})
      .then(async () => {
        const db = await open();
        return new Promise<Journal>((resolve, reject) => {
          const tx = db.transaction("partitions", "readwrite");
          const store = tx.objectStore("partitions");
          const read = store.get(partition);
          let result: Journal;
          read.onsuccess = () => {
            try {
              const current = read.result;
              result = change({
                revision: Number.isSafeInteger(current?.revision)
                  ? current.revision
                  : 0,
                records: Array.isArray(current?.records) ? current.records : [],
              });
              store.put(result, partition);
            } catch {
              tx.abort();
            }
          };
          tx.oncomplete = () => resolve(result);
          tx.onabort = () =>
            reject(
              tx.error ?? new Error("Activity history changed or unavailable"),
            );
          tx.onerror = () => reject(tx.error);
        });
      });
    queue = operation;
    return operation;
  }
  return {
    async load() {
      pending = undefined; // Reads and clears are ordering barriers between append batches.
      const journal = await update((current) => {
        revision = current.revision;
        return {
          ...current,
          records: retainedActivity(
            current.records,
            viewer,
            Date.now(),
            verify,
          ),
        };
      });
      return journal.records;
    },
    async append(record) {
      if (closed) throw new Error("Activity history closed");
      if (pending) {
        pending.records.push(record);
        if (pending.records.length > HISTORY_RECORD_LIMIT)
          pending.records.shift();
        return pending.done;
      }
      const records = [record];
      const done = update((current) => {
        if (pending?.records === records) pending = undefined;
        if (revision !== current.revision)
          throw new Error("Activity history was cleared");
        return {
          ...current,
          records: retainedActivity(
            [...current.records, ...records],
            viewer,
            Date.now(),
            verify,
          ),
        };
      }).then(() => {});
      pending = { records, done };
      // An open/transaction failure can happen before the update callback runs.
      void done.catch(() => {
        if (pending?.records === records) pending = undefined;
      });
      return done;
    },
    async clear() {
      pending = undefined;
      await update((current) => {
        revision = current.revision + 1;
        return { revision, records: [] };
      });
    },
    close() {
      closed = true;
      // Finish admitted operations before closing; no plaintext ever enters this queue.
      void queue
        .catch(() => {})
        .then(() => database?.then((db) => db.close()))
        .catch(() => {});
    },
  };
}
