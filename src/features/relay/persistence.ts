import { byteSize } from "./budget";
/** Signed wire records only. The owner re-verifies and folds these after fresh roster authorization.
 * A cache hit is never authority for membership or freshness. No keys/tokens are persisted. */
export type SavedHead = {
  channelId: string;
  savedAt: number;
  events: unknown[];
  profiles: unknown[];
};
export interface HeadPersistence {
  read(): Promise<SavedHead[]>;
  write(head: SavedHead): Promise<void>;
  remove(channelId: string): Promise<void>;
  retain(channelIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
const DB = "buzz-channel-heads-v1";
const STORE = "heads";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_HEADS = 64;
const MAX_AGE = 24 * 60 * 60 * 1000;
type Record = SavedHead & { key: string; scope: string; bytes: number };

export function createHeadPersistence(
  viewer: string,
  relay: string,
): HeadPersistence {
  const scope = `${viewer}:${relay}`;
  let closed = false;
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (closed || typeof indexedDB === "undefined")
      return Promise.reject(new Error("Cache unavailable"));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        reject(new Error("Cache open timed out"));
      }, 1500);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onerror = () => {
        clearTimeout(timeout);
        reject(request.error);
      };
      request.onblocked = () => {
        expired = true;
        clearTimeout(timeout);
        reject(new Error("Cache blocked"));
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (closed || expired) {
          request.result.close();
          reject(new Error("Cache closed"));
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return opening;
  }
  async function transact<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, done: (value: T) => void) => void,
  ): Promise<T> {
    const db = await database();
    if (closed) throw new Error("Cache closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result: T;
      const timeout = setTimeout(() => {
        tx.abort();
      }, 2000);
      tx.oncomplete = () => {
        clearTimeout(timeout);
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        clearTimeout(timeout);
        reject(tx.error ?? new Error("Cache transaction aborted"));
      };
      work(tx.objectStore(STORE), (value) => {
        result = value;
      });
    });
  }
  return {
    read: () =>
      transact("readonly", (store, done) => {
        const request = store.getAll();
        request.onsuccess = () =>
          done(
            (request.result as Record[])
              .filter(
                (row) =>
                  row.scope === scope && Date.now() - row.savedAt < MAX_AGE,
              )
              .sort((a, b) => b.savedAt - a.savedAt)
              .slice(0, MAX_HEADS),
          );
      }),
    write: (head) =>
      transact("readwrite", (store, done) => {
        const bytes = byteSize(head);
        if (bytes > MAX_BYTES) {
          done(undefined);
          return;
        }
        const row: Record = {
          ...head,
          scope,
          key: `${scope}:${head.channelId}`,
          bytes,
        };
        store.put(row);
        const request = store.getAll();
        request.onsuccess = () => {
          // Global disk budget across identities; scope is still required for every read.
          let total = 0,
            count = 0;
          for (const entry of (request.result as Record[]).sort(
            (a, b) => b.savedAt - a.savedAt,
          )) {
            total += entry.bytes;
            count++;
            if (
              total > MAX_BYTES ||
              count > MAX_HEADS ||
              Date.now() - entry.savedAt >= MAX_AGE
            )
              store.delete(entry.key);
          }
          done(undefined);
        };
      }),
    remove: (channelId) =>
      transact("readwrite", (store, done) => {
        store.delete(`${scope}:${channelId}`);
        done(undefined);
      }),
    retain: (ids) =>
      transact("readwrite", (store, done) => {
        const allowed = new Set(ids),
          request = store.getAll();
        request.onsuccess = () => {
          for (const row of request.result as Record[])
            if (row.scope === scope && !allowed.has(row.channelId))
              store.delete(row.key);
          done(undefined);
        };
      }),
    clear: () =>
      transact("readwrite", (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => {
          for (const row of request.result as Record[])
            if (row.scope === scope) store.delete(row.key);
          done(undefined);
        };
      }),
    close() {
      closed = true;
      void opening?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
