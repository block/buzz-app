import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import { byteSize } from "./budget";
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
export type SavedHeadIndex = Pick<SavedHead, "channelId" | "savedAt">;
export interface HeadPersistence {
  read(): Promise<SavedHead[]>;
  /** The store can prioritize current intent before loading unrelated payloads.
   * Implementations without both capabilities retain the complete read path. */
  readIndex?(): Promise<SavedHeadIndex[]>;
  readHead?(channelId: string): Promise<SavedHead | undefined>;
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
const PAYLOADS = "payloads";
const REFERENCES = "references";
const RECENCY = "recency";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_HEADS = 64;
const MAX_AGE = 24 * 60 * 60 * 1000;
type Record = SavedHead & { key: string; scope: string; bytes: number };
type Manifest = Omit<Record, "events" | "profiles"> & {
  version: 3 | 4;
  eventRefs: string[];
  profileRefs: string[];
};
type Metadata = Pick<
  Record,
  "key" | "scope" | "bytes" | "savedAt" | "channelId"
>;
type Payload = { key: string; scope: string; wire: string };
const encoder = new TextEncoder();

/** Hash the exact JSON wire, including its signature. A digest is a storage key,
 * never a verification proof; the store still admits every restored event. */
function encodeHead(head: SavedHead) {
  const wires = new Map<string, string>();
  const encode = (values: unknown[]) => {
    if (!values.length) return [];
    const wire = JSON.stringify(values);
    const digest = bytesToHex(
      schnorr.utils.taggedHash("buzz-head-wire-v1", encoder.encode(wire)),
    );
    wires.set(digest, wire);
    return [digest];
  };
  return {
    eventRefs: encode(head.events),
    profileRefs: encode(head.profiles),
    wires,
  };
}

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
      const request = indexedDB.open(DB, 4);
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        reject(new Error("Cache open timed out"));
      }, 1500);
      request.onupgradeneeded = () => {
        for (const name of [STORE, STARTUP])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name, { keyPath: "key" });
        // Legacy bodies stay intact. Index construction is native; no JS getAll
        // migration blocks the first selected head or discards an old cache.
        const heads = request.transaction?.objectStore(STORE);
        if (heads && !heads.indexNames.contains("scope"))
          heads.createIndex("scope", "scope");
        if (heads && !heads.indexNames.contains(RECENCY))
          heads.createIndex(RECENCY, [
            "savedAt",
            "key",
            "bytes",
            "scope",
            "channelId",
          ]);
        const startup = request.transaction?.objectStore(STARTUP);
        if (startup && !startup.indexNames.contains(RECENCY))
          startup.createIndex(RECENCY, ["savedAt", "key", "bytes"]);
        if (!request.result.objectStoreNames.contains(PAYLOADS))
          request.result.createObjectStore(PAYLOADS, { keyPath: "key" });
        if (!request.result.objectStoreNames.contains(REFERENCES)) {
          const references = request.result.createObjectStore(REFERENCES, {
            keyPath: "key",
          });
          references.createIndex("owner", "owner");
          references.createIndex("payload", "payload");
        }
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
  async function transact<T>(
    mode: IDBTransactionMode,
    work: (
      store: IDBObjectStore,
      done: (value: T) => void,
      then: Then,
      tx: IDBTransaction,
    ) => void,
    name = STORE,
  ): Promise<T> {
    const db = await database();
    if (closed) throw new Error("Cache closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([STORE, STARTUP, PAYLOADS, REFERENCES], mode);
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
      const fail = (error: unknown) => {
        ended = true;
        clearTimeout(timeout);
        try {
          tx.abort();
        } catch {
          /* It may already have aborted. */
        }
        reject(error);
      };
      try {
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
                // WebKit can deliver a queued success after a native abort.
                if (
                  error instanceof DOMException &&
                  error.name === "TransactionInactiveError"
                )
                  ended = true;
                else fail(error);
              }
            };
          },
          tx,
        );
      } catch (error) {
        fail(error);
      }
    });
  }
  /** Normal accounting reads only index keys, including for untouched v2 rows.
   * Damaged fields can omit an entry; preserve the prior full-record policy then. */
  function metadata(
    store: IDBObjectStore,
    then: Then,
    done: (rows: Metadata[]) => void,
  ) {
    then(store.count(), (count) => {
      const rows: Metadata[] = [];
      then(store.index(RECENCY).openKeyCursor(), (cursor) => {
        if (!cursor) {
          if (rows.length !== count) {
            then(store.getAll(), (all: Metadata[]) =>
              done(all.sort((a, b) => b.savedAt - a.savedAt)),
            );
            return;
          }
          // getAll + stable sort used primary-key order for equal dates.
          rows.sort(
            (a, b) => b.savedAt - a.savedAt || indexedDB.cmp(a.key, b.key),
          );
          done(rows);
          return;
        }
        const [savedAt, key, bytes, rowScope, channelId] = cursor.key as [
          number,
          string,
          number,
          string,
          string,
        ];
        rows.push({ savedAt, key, bytes, scope: rowScope, channelId });
        cursor.continue();
      });
    });
  }

  function unlink(
    owner: string,
    garbage: Set<string>,
    tx: IDBTransaction,
    then: Then,
    done: () => void,
  ) {
    const references = tx.objectStore(REFERENCES);
    then(references.index("owner").getAllKeys(owner), (keys) => {
      for (const key of keys) {
        references.delete(key);
        const payload = (key as string[])[1];
        if (payload) garbage.add(payload);
      }
      done();
    });
  }
  function collect(garbage: Set<string>, tx: IDBTransaction, then: Then) {
    for (const key of garbage)
      then(tx.objectStore(REFERENCES).index("payload").count(key), (count) => {
        if (!count) tx.objectStore(PAYLOADS).delete(key);
      });
  }
  function removeHeads(
    keys: IDBValidKey[],
    garbage: Set<string>,
    tx: IDBTransaction,
    then: Then,
    done: () => void,
  ) {
    let remaining = keys.length;
    if (!remaining) {
      done();
      return;
    }
    for (const key of keys) {
      tx.objectStore(STORE).delete(key);
      unlink(`h:${key}`, garbage, tx, then, () => {
        if (!--remaining) done();
      });
    }
  }
  function installWires(
    owner: string,
    wires: Map<string, string>,
    tx: IDBTransaction,
    then: Then,
    done: () => void,
  ) {
    const payloads = tx.objectStore(PAYLOADS);
    const references = tx.objectStore(REFERENCES);
    let remaining = wires.size;
    if (!remaining) {
      done();
      return;
    }
    for (const [digest, wire] of wires) {
      const key = `${scope}:${digest}`;
      const linked = () => {
        references.put({ key: [owner, key], owner, payload: key });
        if (!--remaining) done();
      };
      // Only read the payload being reused. A fresh valid write must repair
      // corrupt disk bytes rather than permanently pinning a poisoned hash key.
      then(payloads.get(key), (existing: Payload | undefined) => {
        if (existing?.wire !== wire || existing.scope !== scope)
          then(payloads.put({ key, scope, wire } satisfies Payload), linked);
        else linked();
      });
    }
  }
  function decodeHead(
    row: Record | Manifest,
    tx: IDBTransaction,
    then: Then,
    done: (head: SavedHead | undefined) => void,
  ) {
    if (!("version" in row) || (row.version !== 3 && row.version !== 4)) {
      done(row as Record);
      return;
    }
    if (
      !Array.isArray(row.eventRefs) ||
      !Array.isArray(row.profileRefs) ||
      (row.version === 4 &&
        (row.eventRefs.length > 1 || row.profileRefs.length > 1))
    ) {
      done(undefined);
      return;
    }
    const refs = [...new Set([...row.eventRefs, ...row.profileRefs])];
    if (
      refs.some(
        (digest) =>
          typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest),
      )
    ) {
      done(undefined);
      return;
    }
    const values = new Map<string, unknown>();
    let valid = true;
    const list = (refs: string[]) =>
      row.version === 4
        ? refs.flatMap((key) => values.get(key) as unknown[])
        : refs.map((key) => values.get(key));
    const finish = () =>
      done(
        valid
          ? {
              channelId: row.channelId,
              savedAt: row.savedAt,
              events: list(row.eventRefs),
              profiles: list(row.profileRefs),
            }
          : undefined,
      );
    let remaining = refs.length;
    if (!remaining) {
      finish();
      return;
    }
    for (const digest of refs) {
      then(
        tx.objectStore(PAYLOADS).get(`${scope}:${digest}`),
        (payload: Payload | undefined) => {
          try {
            if (
              !payload ||
              payload.scope !== scope ||
              typeof payload.wire !== "string"
            )
              valid = false;
            else {
              const value: unknown = JSON.parse(payload.wire);
              if (row.version === 4 && !Array.isArray(value)) valid = false;
              else values.set(digest, value);
            }
          } catch {
            valid = false;
          }
          if (!--remaining) finish();
        },
      );
    }
  }
  return {
    readIndex: () =>
      transact("readonly", (store, done, then) => {
        metadata(store, then, (rows) =>
          done(
            rows
              .filter(
                (row) =>
                  row.scope === scope && Date.now() - row.savedAt < MAX_AGE,
              )
              .slice(0, MAX_HEADS)
              .map(({ channelId, savedAt }) => ({ channelId, savedAt })),
          ),
        );
      }),
    readHead: (channelId) =>
      transact("readonly", (store, done, then, tx) => {
        then(
          store.get(`${scope}:${channelId}`),
          (row: Record | Manifest | undefined) => {
            if (
              !row ||
              row.scope !== scope ||
              Date.now() - row.savedAt >= MAX_AGE
            ) {
              done(undefined);
              return;
            }
            decodeHead(row, tx, then, done);
          },
        );
      }),
    readStartup: () =>
      transact(
        "readonly",
        (store, done, then) => then(store.get(scope), (row) => done(row?.data)),
        STARTUP,
      ),
    writeStartup: (patch) =>
      transact(
        "readwrite",
        (store, done, then) =>
          then(store.get(scope), (row) => {
            const data = { ...row?.data, ...patch };
            const bytes = byteSize(data);
            if (bytes <= MAX_BYTES) {
              store.put({ key: scope, data, bytes, savedAt: Date.now() });
              metadata(store, then, (rows) => {
                let total = 0;
                for (const row of rows.sort((a, b) => b.savedAt - a.savedAt)) {
                  total += row.bytes;
                  if (total > MAX_BYTES) store.delete(row.key);
                }
              });
            }
            done(undefined);
          }),
        STARTUP,
      ),
    read: () =>
      transact("readonly", (store, done, then, tx) =>
        then(
          store.index("scope").getAll(scope),
          (rows: (Record | Manifest)[]) => {
            const retained = rows
              .filter(
                (row) =>
                  row.scope === scope && Date.now() - row.savedAt < MAX_AGE,
              )
              .sort((a, b) => b.savedAt - a.savedAt)
              .slice(0, MAX_HEADS);
            const heads: (SavedHead | undefined)[] = new Array(retained.length);
            let remaining = retained.length;
            if (!remaining) done([]);
            retained.forEach((row, index) => {
              decodeHead(row, tx, then, (head) => {
                heads[index] = head;
                if (!--remaining)
                  done(
                    heads.filter(
                      (value): value is SavedHead => value !== undefined,
                    ),
                  );
              });
            });
          },
        ),
      ),
    write: (head) =>
      transact("readwrite", (store, done, then, tx) => {
        const bytes = byteSize(head);
        if (bytes > MAX_BYTES) {
          done(undefined);
          return;
        }
        const { wires, ...refs } = encodeHead(head);
        const row: Manifest = {
          channelId: head.channelId,
          savedAt: head.savedAt,
          version: 4,
          ...refs,
          scope,
          key: `${scope}:${head.channelId}`,
          bytes,
        };
        const garbage = new Set<string>();
        unlink(`h:${row.key}`, garbage, tx, then, () =>
          installWires(`h:${row.key}`, wires, tx, then, () => {
            store.put(row);
            metadata(store, then, (rows) => {
              // Global disk budget across identities; scope is still required for every read.
              let total = 0,
                count = 0;
              const removed: IDBValidKey[] = [];
              for (const entry of rows) {
                total += entry.bytes;
                count++;
                if (
                  total > MAX_BYTES ||
                  count > MAX_HEADS ||
                  Date.now() - entry.savedAt >= MAX_AGE
                )
                  removed.push(entry.key);
              }
              removeHeads(removed, garbage, tx, then, () => {
                collect(garbage, tx, then);
                done(undefined);
              });
            });
          }),
        );
      }),
    remove: (channelId) =>
      transact("readwrite", (_store, done, then, tx) => {
        const garbage = new Set<string>();
        removeHeads([`${scope}:${channelId}`], garbage, tx, then, () => {
          collect(garbage, tx, then);
          done(undefined);
        });
      }),
    retain: (ids) =>
      transact("readwrite", (store, done, then, tx) => {
        const allowed = new Set(ids.map((id) => `${scope}:${id}`));
        then(store.index("scope").getAllKeys(scope), (keys) => {
          const garbage = new Set<string>();
          removeHeads(
            keys.filter((key) => typeof key !== "string" || !allowed.has(key)),
            garbage,
            tx,
            then,
            () => {
              collect(garbage, tx, then);
              done(undefined);
            },
          );
        });
      }),
    clear: () =>
      transact("readwrite", (store, done, then, tx) => {
        tx.objectStore(STARTUP).delete(scope);
        then(store.index("scope").getAllKeys(scope), (keys) => {
          const garbage = new Set<string>();
          removeHeads(keys, garbage, tx, then, () => {
            collect(garbage, tx, then);
            done(undefined);
          });
        });
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
