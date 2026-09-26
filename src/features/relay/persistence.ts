import { byteSize, HEAD_MAX_AGE } from "./budget";
import type { SidebarPreferences } from "./sidebar-preferences";
/** Device-local resume data, never proof of current access or permission to write. */
export type SavedStartup = {
  discovery?: {
    savedAt: number;
    relayAuthor: string;
    events: unknown[];
    profiles?: unknown[];
  };
  preferences?: { savedAt: number; data: SidebarPreferences };
};
/** Signed wire records only. The owner re-verifies before displaying cached history.
 * A cache hit is never authority for current membership or freshness. No keys/tokens are persisted. */
export type SavedHead = {
  channelId: string;
  savedAt: number;
  events: unknown[];
  profiles: unknown[];
};
export interface HeadPersistence {
  read(): Promise<SavedHead[]>;
  readStartup?(): Promise<SavedStartup | undefined>;
  writeStartup?(patch: SavedStartup): Promise<void>;
  write(head: SavedHead): Promise<void>;
  remove(channelId: string): Promise<void>;
  retain(channelIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
const DB = "buzz-channel-heads-v1";
const STORE = "heads";
const STARTUP = "startup";
// Key-only head indexes: budget checks and purges never deserialize saved windows.
const BY_SCOPE = "scope";
const BY_BUDGET = "budget";
// Sized for a full roster of opened windows (~40 KB each), below the store's 24 MiB
// in-memory head budget. Cached heads never prove freshness or membership.
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_HEADS = 256;
const MAX_STARTUP_BYTES = 8 * 1024 * 1024;
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
      const request = indexedDB.open(DB, 3);
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        reject(new Error("Cache open timed out"));
      }, 1500);
      request.onupgradeneeded = () => {
        for (const name of [STORE, STARTUP])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name, { keyPath: "key" });
        // Version 3 indexes existing head records in place; no saved window is lost.
        const heads = request.transaction?.objectStore(STORE);
        if (heads && !heads.indexNames.contains(BY_SCOPE))
          heads.createIndex(BY_SCOPE, "scope");
        if (heads && !heads.indexNames.contains(BY_BUDGET))
          heads.createIndex(BY_BUDGET, ["savedAt", "bytes"]);
      };
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
    name = STORE,
  ): Promise<T> {
    const db = await database();
    if (closed) throw new Error("Cache closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
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
      work(tx.objectStore(name), (value) => {
        result = value;
      });
    });
  }
  return {
    readStartup: () =>
      transact(
        "readonly",
        (store, done) => {
          const request = store.get(scope);
          request.onsuccess = () => done(request.result?.data);
        },
        STARTUP,
      ),
    writeStartup: (patch) =>
      transact(
        "readwrite",
        (store, done) => {
          const request = store.get(scope);
          request.onsuccess = () => {
            const data = { ...request.result?.data, ...patch };
            const bytes = byteSize(data);
            if (bytes <= MAX_STARTUP_BYTES) {
              store.put({ key: scope, data, bytes, savedAt: Date.now() });
              const all = store.getAll();
              all.onsuccess = () => {
                let total = 0;
                for (const row of all.result.sort(
                  (a, b) => b.savedAt - a.savedAt,
                )) {
                  total += row.bytes;
                  if (total > MAX_STARTUP_BYTES) store.delete(row.key);
                }
              };
            }
            done(undefined);
          };
        },
        STARTUP,
      ),
    read: () =>
      transact("readonly", (store, done) => {
        const request = store.index(BY_SCOPE).getAll(scope);
        request.onsuccess = () =>
          done(
            (request.result as Record[])
              .filter((row) => Date.now() - row.savedAt < HEAD_MAX_AGE)
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
        // Global disk budget across identities, newest first; scope is still required for every read.
        const request = store.index(BY_BUDGET).openKeyCursor(null, "prev");
        let total = 0,
          count = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            done(undefined);
            return;
          }
          const [savedAt, size] = cursor.key as [number, number];
          total += size;
          count++;
          if (
            total > MAX_BYTES ||
            count > MAX_HEADS ||
            Date.now() - savedAt >= HEAD_MAX_AGE
          )
            store.delete(cursor.primaryKey);
          cursor.continue();
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
          request = store.index(BY_SCOPE).getAllKeys(scope);
        request.onsuccess = () => {
          for (const key of request.result as string[])
            if (!allowed.has(key.slice(scope.length + 1))) store.delete(key);
          done(undefined);
        };
      }),
    clear: async () => {
      await transact(
        "readwrite",
        (store, done) => {
          store.delete(scope);
          done(undefined);
        },
        STARTUP,
      );
      await transact("readwrite", (store, done) => {
        const request = store.index(BY_SCOPE).getAllKeys(scope);
        request.onsuccess = () => {
          for (const key of request.result) store.delete(key);
          done(undefined);
        };
      });
    },
    close() {
      closed = true;
      void opening?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
