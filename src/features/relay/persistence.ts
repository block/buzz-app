import { byteSize } from "./budget";
import type { SidebarPreferences } from "./sidebar-preferences";
/** Device-local resume data, never proof of current access or permission to write. */
export type SavedStartup = {
  discovery?: {
    savedAt: number;
    relayAuthor: string;
    events: unknown[];
  };
  /** The verified-profile authority last observed, `null` once disabled, so
   * a cached session can show saved verified names before discovery. */
  verifiedProfiles?: unknown;
  preferences?: { savedAt: number; data: SidebarPreferences };
};
/** Signed wire records only. The owner re-verifies before displaying cached history.
 * A cache hit is never authority for current membership or freshness. No keys/tokens are persisted. */
export type SavedHead = {
  channelId: string;
  savedAt: number;
  events: unknown[];
  /** Membership notices among the events, read apart from them. */
  notices?: unknown[];
  profiles: unknown[];
};
export class StartupRosterSuperseded extends Error {
  constructor(readonly observePeer?: () => void) {
    super("Startup roster changed");
  }
}

export interface HeadPersistence {
  read(): Promise<SavedHead[]>;
  readStartup?(options?: {
    observeDiscovery?: boolean;
  }): Promise<SavedStartup | undefined>;
  writeStartup?(
    patch: SavedStartup,
    revoked?: boolean,
    ifUnchanged?: boolean,
  ): Promise<void>;
  /** Signed kind 0 and verified-profile (30382) events mirrored from the profile directory. */
  readProfiles?(): Promise<unknown[]>;
  writeProfiles?(events: readonly unknown[]): Promise<void>;
  write(head: SavedHead): Promise<void>;
  remove(channelId: string): Promise<void>;
  retain(channelIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
const DB = "buzz-channel-heads-v1";
const STORE = "heads";
const STARTUP = "startup";
const MIRROR = ":profiles";
const STARTUP_BUDGET = `!budget${MIRROR}`;
/** The largest row saved; a larger one is not written at all. */
export const MAX_BYTES = 8 * 1024 * 1024;
const MAX_HEADS = 64;
const MAX_AGE = 24 * 60 * 60 * 1000;
type RowBudget = { key: string; bytes: number; savedAt: number };
type Record = SavedHead & RowBudget & { scope: string };
type ScopedRow = Pick<Record, "scope" | "channelId"> & { key: IDBValidKey };

// History keys are strings. Array keys let us load the metadata on its own
// without changing the database version that older builds open.
const historyKeys = () => IDBKeyRange.upperBound([], true);
const metadataKeys = () => IDBKeyRange.lowerBound([]);

function putHeadMeta(
  store: IDBObjectStore,
  { key, bytes, savedAt, scope, channelId }: Record,
) {
  store.put({
    key: [key],
    scope,
    channelId,
    // Older builds can clear these rows by scope. Their writes expire every
    // metadata row, so an older same-key write also invalidates the budget.
    savedAt: Number.NEGATIVE_INFINITY,
    bytes: 0,
    head: { key, bytes, savedAt } satisfies RowBudget,
  });
}

function deleteHead(store: IDBObjectStore, key: string) {
  store.delete(key);
  store.delete([key]);
}

function discoveryVersion(discovery: SavedStartup["discovery"]): string | null {
  if (!discovery) return null;
  return JSON.stringify([
    discovery.savedAt,
    discovery.relayAuthor,
    Array.isArray(discovery.events)
      ? (discovery.events as ({ id?: unknown } | null)[]).map((event) =>
          typeof event?.id === "string" ? event.id : null,
        )
      : null,
  ]);
}

export function createHeadPersistence(
  viewer: string,
  relay: string,
): HeadPersistence {
  const scope = `${viewer}:${relay}`;
  const profiles = `${scope}${MIRROR}`;
  let closed = false;
  let opening: Promise<IDBDatabase> | undefined;
  let observedDiscovery: string | null | undefined;
  function database() {
    if (closed || typeof indexedDB === "undefined")
      return Promise.reject(new Error("Cache unavailable"));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 2);
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        reject(new Error("Cache open timed out"));
      }, 1500);
      request.onupgradeneeded = () => {
        for (const name of [STORE, STARTUP])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name, { keyPath: "key" });
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
  /** `handler` must issue follow-up requests synchronously (IDB auto-commits). */
  type Then = <R>(request: IDBRequest<R>, handler: (result: R) => void) => void;
  function writeStartupBudget(store: IDBObjectStore, rows: RowBudget[]) {
    if (!rows.length) {
      store.delete(STARTUP_BUDGET);
      return;
    }
    // Older builds still open this version. Their prune puts this marker last
    // and evicts it, so their writes cannot leave a stale budget behind.
    store.put({
      key: STARTUP_BUDGET,
      bytes: MAX_BYTES + 1,
      savedAt: Number.NEGATIVE_INFINITY,
      data: {},
      rows,
    });
  }
  /** Keep the startup store, across identities, within its byte budget.
   * Optional profile mirrors give way before any saved roster. */
  function prune(
    store: IDBObjectStore,
    then: Then,
    updated: RowBudget,
    saved?: (kept: boolean) => void,
  ) {
    then(
      store.get(STARTUP_BUDGET),
      (budget: { rows: RowBudget[] } | undefined) => {
        const known = new Map(budget?.rows.map((row) => [row.key, row]));
        known.set(updated.key, updated);
        then(store.getAllKeys(), (keys) => {
          const rows: RowBudget[] = [];
          const missing: string[] = [];
          for (const key of keys) {
            if (typeof key !== "string" || key === STARTUP_BUDGET) continue;
            const row = known.get(key);
            if (row) rows.push(row);
            else missing.push(key);
          }
          const trim = () => {
            const mirror = (row: RowBudget) => Number(row.key.endsWith(MIRROR));
            let total = 0;
            const kept: RowBudget[] = [];
            for (const row of rows.sort(
              (a, b) => mirror(a) - mirror(b) || b.savedAt - a.savedAt,
            )) {
              total += row.bytes;
              if (total > MAX_BYTES) store.delete(row.key);
              else kept.push(row);
            }
            writeStartupBudget(store, kept);
            saved?.(kept.includes(updated));
          };
          // Import sizes once for rows written before the budget was present.
          let pending = missing.length;
          if (pending === 0) trim();
          for (const key of missing)
            then(store.get(key), ({ bytes, savedAt }: RowBudget) => {
              rows.push({ key, bytes, savedAt });
              if (--pending === 0) trim();
            });
        });
      },
    );
  }
  async function transact<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, done: (value: T) => void, then: Then) => void,
    name = STORE,
  ): Promise<T> {
    const db = await database();
    if (closed) throw new Error("Cache closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
      let result: T;
      let ended = false;
      const timeout = setTimeout(() => {
        ended = true;
        try {
          tx.abort();
        } catch (error) {
          // Native completion can precede its queued event. Let that event
          // settle the operation when the transaction can no longer abort.
          if (
            !(
              error instanceof DOMException &&
              error.name === "InvalidStateError"
            )
          )
            reject(error);
        }
      }, 2000);
      tx.oncomplete = () => {
        clearTimeout(timeout);
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        ended = true;
        clearTimeout(timeout);
        reject(tx.error ?? new Error("Cache transaction aborted"));
      };
      work(
        tx.objectStore(name),
        (value) => {
          result = value;
        },
        (request, handler) => {
          request.onsuccess = () => {
            if (ended) return;
            try {
              handler(request.result);
            } catch (error) {
              // WebKit delivers a queued success after a browser-initiated abort.
              if (
                !(
                  error instanceof DOMException &&
                  error.name === "TransactionInactiveError"
                )
              )
                throw error;
              ended = true;
            }
          };
        },
      );
    });
  }
  return {
    readStartup: ({ observeDiscovery } = {}) =>
      transact(
        "readonly",
        (store, done, then) =>
          then(store.get(scope), (row) => {
            const data = row?.data as SavedStartup | undefined;
            if (observeDiscovery)
              observedDiscovery = discoveryVersion(data?.discovery);
            done(data);
          }),
        STARTUP,
      ),
    async writeStartup(patch, revoked = false, ifUnchanged = false) {
      let version: string | null | undefined;
      const saved = await transact<boolean | undefined>(
        "readwrite",
        (store, done, then) =>
          then(store.get(scope), (row) => {
            if (
              patch.discovery &&
              (ifUnchanged || observedDiscovery === undefined)
            ) {
              const current = discoveryVersion(row?.data?.discovery);
              // Compare inside the write transaction. Settings-only changes
              // preserve the signed snapshot, but a peer can replace or clear it.
              if (ifUnchanged && current !== observedDiscovery) {
                version = current;
                return done(undefined);
              }
              if (observedDiscovery === undefined) observedDiscovery = current;
            }
            const data: SavedStartup = { ...row?.data, ...patch };
            let bytes = byteSize(data);
            if (bytes > MAX_BYTES && revoked) {
              // An oversized replacement must still remove the revoked roster.
              delete data.discovery;
              bytes = byteSize(data);
            }
            if (bytes > MAX_BYTES) return done(false);
            if (patch.discovery) version = discoveryVersion(data.discovery);
            const meta = { key: scope, bytes, savedAt: Date.now() };
            store.put({ ...meta, data });
            prune(store, then, meta, done);
          }),
        STARTUP,
      );
      if (saved === undefined) {
        const peerVersion = version;
        throw new StartupRosterSuperseded(
          peerVersion
            ? () => {
                observedDiscovery = peerVersion;
              }
            : undefined,
        );
      }
      if (!saved) throw new Error("Startup cache is over its byte budget");
      if (version !== undefined) observedDiscovery = version;
    },
    readProfiles: () =>
      transact(
        "readonly",
        (store, done, then) =>
          then(store.get(profiles), (row) => done(row?.data ?? [])),
        STARTUP,
      ),
    writeProfiles: (events) =>
      transact(
        "readwrite",
        (store, done, then) => {
          const bytes = byteSize(events);
          if (bytes <= MAX_BYTES) {
            const meta = { key: profiles, bytes, savedAt: Date.now() };
            store.put({ ...meta, data: events });
            prune(store, then, meta);
          }
          done(undefined);
        },
        STARTUP,
      ),
    read: () =>
      transact("readonly", (store, done, then) =>
        then(store.getAll(historyKeys()), (rows: Record[]) =>
          done(
            rows
              .filter(
                (row) =>
                  row.scope === scope && Date.now() - row.savedAt < MAX_AGE,
              )
              .sort((a, b) => b.savedAt - a.savedAt)
              .slice(0, MAX_HEADS),
          ),
        ),
      ),
    write: (head) =>
      transact("readwrite", (store, done, then) => {
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
        putHeadMeta(store, row);
        const size = store.count();
        const pruneHeads = (rows: RowBudget[]) => {
          // Global disk budget across identities; scope is still required for every read.
          let total = 0,
            count = 0;
          for (const entry of rows.sort((a, b) => b.savedAt - a.savedAt)) {
            total += entry.bytes;
            count++;
            if (
              total > MAX_BYTES ||
              count > MAX_HEADS ||
              Date.now() - entry.savedAt >= MAX_AGE
            )
              deleteHead(store, entry.key);
          }
          done(undefined);
        };
        const metadata = metadataKeys();
        then(store.getAll(metadata), (rows: { head: RowBudget }[]) => {
          // New writes keep one metadata row per head. An older writer drops
          // all metadata, and an older point delete can leave an extra row.
          if (size.result === 2 * rows.length) {
            pruneHeads(rows.map((row) => row.head));
            return;
          }
          then(store.getAll(historyKeys()), (heads: Record[]) => {
            store.delete(metadata);
            for (const head of heads) putHeadMeta(store, head);
            pruneHeads(heads);
          });
        });
      }),
    remove: (channelId) =>
      transact("readwrite", (store, done) => {
        deleteHead(store, `${scope}:${channelId}`);
        done(undefined);
      }),
    retain: (ids) =>
      transact("readwrite", (store, done, then) => {
        const allowed = new Set(ids);
        then(store.getAll(), (rows: ScopedRow[]) => {
          for (const row of rows)
            if (row.scope === scope && !allowed.has(row.channelId))
              store.delete(row.key);
          done(undefined);
        });
      }),
    clear: async () => {
      await transact(
        "readwrite",
        (store, done, then) => {
          store.delete(scope);
          store.delete(profiles);
          then(store.get(STARTUP_BUDGET), (budget) => {
            if (!budget) return;
            writeStartupBudget(
              store,
              (budget.rows as RowBudget[]).filter(
                ({ key }) => key !== scope && key !== profiles,
              ),
            );
          });
          done(undefined);
        },
        STARTUP,
      );
      observedDiscovery = null;
      await transact("readwrite", (store, done, then) =>
        // Include metadata left by a point delete on an older build.
        then(store.getAll(), (rows: ScopedRow[]) => {
          for (const row of rows)
            if (row.scope === scope) store.delete(row.key);
          done(undefined);
        }),
      );
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
