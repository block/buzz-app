import { byteSize } from "./budget";
import type { RosterRemoval } from "./discovery";
import { newer, type EventData } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";

type RosterVersion = Pick<EventData, "id" | "created_at">;
type SignedRemovalVersion = RosterVersion & { channel: string };

/** Device-local resume data, never proof of current access or permission to write. */
export type SavedStartup = {
  discovery?: {
    savedAt: number;
    relayAuthor: string;
    events: unknown[];
    /** Versions of signed exclusions, with no roster payload or member list. */
    removals?: SignedRemovalVersion[];
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

export class StartupCacheOverBudget extends Error {
  constructor(readonly removalsSettled = false) {
    super("Startup cache is over its byte budget");
  }
}

type RosterChanges = {
  removalFor: ((channel: string) => RosterRemoval | undefined) | undefined;
  signedRemovals: (() => Iterable<SignedRemovalVersion>) | undefined;
  includesGrant: ((channel: string) => boolean) | undefined;
};

export interface HeadPersistence {
  read(): Promise<SavedHead[]>;
  readStartup?(options?: {
    observeDiscovery?: boolean;
  }): Promise<SavedStartup | undefined>;
  writeStartup?(
    patch: SavedStartup,
    revoked?: boolean,
    ifUnchanged?: boolean,
    changes?: RosterChanges,
  ): Promise<void>;
  /** Signed kind 0 and verified-profile (30382) events mirrored from the profile directory. */
  readProfiles?(): Promise<unknown[]>;
  /** Saves `events`, then the `optional` events that fit in the room the
   * startup store leaves, whole and in order; the earliest give way first. */
  writeProfiles?(
    events: readonly unknown[],
    optional?: readonly unknown[],
  ): Promise<void>;
  write(head: SavedHead): Promise<void>;
  remove(channelId: string): Promise<void>;
  retain(channelIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  /** Bytes saved for this viewer and relay, as recorded when each was written. */
  usage?(): Promise<number>;
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
const isMirror = (row: RowBudget) => row.key.endsWith(MIRROR);
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
    discovery.removals,
  ]);
}

function channelOf(event: Partial<EventData> | null | undefined) {
  if (!Array.isArray(event?.tags)) return undefined;
  if (event.kind !== 39000 && event.kind !== 39002 && event.kind !== 9007)
    return undefined;
  const name = event.kind === 9007 ? "h" : "d";
  return event.tags.find(
    (entry) => Array.isArray(entry) && entry[0] === name,
  )?.[1];
}

function pruneRevokedRosters(
  discovery: NonNullable<SavedStartup["discovery"]>,
  removalFor: (
    channel: string,
  ) => (RosterVersion & { omitted?: boolean }) | undefined,
) {
  const peerVersions = new Map<string, Pick<EventData, "id" | "created_at">>();
  for (const value of discovery.events) {
    const event = value as Partial<EventData> | null;
    if (event?.kind !== 39002 || event.pubkey !== discovery.relayAuthor)
      continue;
    const channel = channelOf(event);
    if (
      channel &&
      removalFor(channel) &&
      typeof event.id === "string" &&
      typeof event.created_at === "number"
    )
      peerVersions.set(
        channel,
        newer(peerVersions.get(channel), {
          id: event.id,
          created_at: event.created_at,
        }),
      );
  }
  const removed = new Set<string>();
  for (const [channel, peer] of peerVersions) {
    const removal = removalFor(channel);
    // A complete read can omit a roster that the peer later confirms.
    if (removal?.omitted && removal.id === peer.id) continue;
    if (removal && newer(removal, peer) === removal) removed.add(channel);
  }
  if (!removed.size) return;
  const events = discovery.events.filter((value) => {
    const channel = channelOf(value as Partial<EventData> | null);
    return !channel || !removed.has(channel);
  });
  return { events, removed };
}

function signedRemovalVersions(
  stored: SignedRemovalVersion[] | undefined,
  incoming: Iterable<SignedRemovalVersion>,
) {
  const versions = new Map<string, SignedRemovalVersion>();
  if (Array.isArray(stored))
    for (const removal of stored)
      if (
        typeof removal?.channel === "string" &&
        typeof removal.id === "string" &&
        Number.isFinite(removal.created_at)
      )
        versions.set(removal.channel, removal);
  let changed = false;
  for (const removal of incoming) {
    const previous = versions.get(removal.channel);
    if (newer(previous, removal) === previous) continue;
    versions.set(removal.channel, removal);
    changed = true;
  }
  return { versions, changed };
}

function mergeRosterUpdates(
  peer: unknown[],
  local: unknown[],
  includesGrant: NonNullable<RosterChanges["includesGrant"]>,
) {
  const updates = new Map<string, EventData>();
  for (const value of local) {
    const event = value as EventData;
    const channel = channelOf(event);
    if (channel && includesGrant(channel))
      updates.set(`${event.kind}:${channel}`, event);
  }
  if (!updates.size) return;
  for (const value of peer) {
    const event = value as Partial<EventData> | null;
    const channel = channelOf(event);
    if (
      !channel ||
      typeof event?.id !== "string" ||
      typeof event.created_at !== "number"
    )
      continue;
    const key = `${event.kind}:${channel}`;
    const update = updates.get(key);
    if (
      update &&
      (event.id === update.id ||
        newer<Pick<EventData, "id" | "created_at">>(update, {
          id: event.id,
          created_at: event.created_at,
        }) !== update)
    )
      updates.delete(key);
  }
  if (!updates.size) return;
  // Keep replacement metadata ahead of its retained creation receipt.
  const events: unknown[] = [];
  const replaced = new Set<string>();
  for (const value of peer) {
    const event = value as Partial<EventData> | null;
    const channel = channelOf(event);
    const key = `${event?.kind}:${channel}`;
    if (!channel || !updates.has(key)) events.push(value);
    else if (!replaced.has(key)) {
      events.push(updates.get(key));
      replaced.add(key);
    }
  }
  for (const [key, event] of updates)
    if (!replaced.has(key)) events.push(event);
  return events;
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
  let observedPeer = false;
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
  function readStartupBudget(
    store: IDBObjectStore,
    then: Then,
    ready: (rows: RowBudget[]) => void,
    updated?: RowBudget,
  ) {
    then(
      store.get(STARTUP_BUDGET),
      (budget: { rows: RowBudget[] } | undefined) => {
        const known = new Map(budget?.rows.map((row) => [row.key, row]));
        if (updated) known.set(updated.key, updated);
        then(store.getAllKeys(), (keys) => {
          const rows: RowBudget[] = [];
          const missing: string[] = [];
          for (const key of keys) {
            if (typeof key !== "string" || key === STARTUP_BUDGET) continue;
            const row = known.get(key);
            if (row) rows.push(row);
            else missing.push(key);
          }
          // Import sizes once for rows written before the budget was present.
          let pending = missing.length;
          if (pending === 0) ready(rows);
          for (const key of missing)
            then(store.get(key), ({ bytes, savedAt }: RowBudget) => {
              rows.push({ key, bytes, savedAt });
              if (--pending === 0) ready(rows);
            });
        });
      },
    );
  }
  /** Enforce the shared startup budget, keeping rosters ahead of mirrors. */
  function pruneStartupBudget(store: IDBObjectStore, rows: RowBudget[]) {
    let total = 0;
    const kept: RowBudget[] = [];
    for (const row of rows.sort(
      (a, b) =>
        Number(isMirror(a)) - Number(isMirror(b)) || b.savedAt - a.savedAt,
    )) {
      total += row.bytes;
      if (total > MAX_BYTES) store.delete(row.key);
      else kept.push(row);
    }
    writeStartupBudget(store, kept);
    return kept;
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
            if (observeDiscovery) {
              observedDiscovery = discoveryVersion(data?.discovery);
              observedPeer = false;
            }
            done(data);
          }),
        STARTUP,
      ),
    async writeStartup(patch, revoked = false, ifUnchanged = false, changes) {
      const removalFor = changes?.removalFor;
      let version: string | null | undefined;
      const saved = await transact<
        boolean | "oversized" | "oversized-with-clean-roster" | undefined
      >(
        "readwrite",
        (store, done, then) =>
          then(store.get(scope), (row) => {
            const stored = row?.data as SavedStartup | undefined;
            let data: SavedStartup = { ...stored, ...patch };
            let local = patch.discovery;
            const peer = stored?.discovery;
            const sameRelay = peer && peer.relayAuthor === local?.relayAuthor;
            const removals = local
              ? signedRemovalVersions(
                  sameRelay ? peer.removals : undefined,
                  changes?.signedRemovals?.() ?? [],
                )
              : undefined;
            const filteredEvents =
              local && removals?.versions.size
                ? pruneRevokedRosters(local, (channel) =>
                    removals.versions.get(channel),
                  )
                : undefined;
            if (local && removals?.versions.size) {
              // Keep the signed exclusion even when a later save omits the
              // channel. A stale grant may arrive from another tab's read.
              local = {
                ...local,
                events: filteredEvents?.events ?? local.events,
                removals: [...removals.versions.values()],
              };
              data.discovery = local;
            }
            let withRemovals: SavedStartup | undefined;
            let mergedUpdates = false;
            let superseded = false;
            let prunedPeer: ReturnType<typeof pruneRevokedRosters>;
            // A filtered grant can have a newer replacement in the peer row.
            const preservePeer = sameRelay && !!filteredEvents;
            if (
              local &&
              (ifUnchanged || preservePeer || observedDiscovery === undefined)
            ) {
              const current = discoveryVersion(stored?.discovery);
              // Compare inside the write transaction. Settings-only changes
              // preserve the signed snapshot, but a peer can replace or clear it.
              // Observing a conflict does not load the peer's channels into
              // discovery. Later removals still have to patch the peer row.
              const conflict =
                ifUnchanged &&
                (current !== observedDiscovery || (removalFor && observedPeer));
              if (preservePeer || conflict) {
                version = current;
                if (!peer || !sameRelay || !Array.isArray(peer.events))
                  return done(undefined);
                prunedPeer =
                  removalFor && pruneRevokedRosters(peer, removalFor);
                const peerEvents = prunedPeer?.events ?? peer.events;
                const peerChannels = new Set<string>();
                // The rejected channel is already absent from local.events.
                // Other signed updates can still advance memberships on disk.
                if (preservePeer)
                  for (const value of peerEvents) {
                    const event = value as Partial<EventData> | null;
                    const channel = channelOf(event);
                    if (
                      event?.kind === 39002 &&
                      channel &&
                      event.pubkey === peer.relayAuthor &&
                      event.tags?.some(
                        (tag) =>
                          Array.isArray(tag) &&
                          tag[0] === "p" &&
                          tag[1] === viewer,
                      )
                    )
                      peerChannels.add(channel);
                  }
                const merged = mergeRosterUpdates(
                  peerEvents,
                  local.events,
                  (channel) =>
                    peerChannels.has(channel) ||
                    !!changes?.includesGrant?.(channel),
                );
                if (!merged && !prunedPeer && !removals?.changed)
                  return done(undefined);
                const peerDiscovery = {
                  ...peer,
                  ...(local.removals && { removals: local.removals }),
                };
                // Apply the eligible evidence to the peer's row. A local
                // snapshot can be missing channels that the peer confirmed.
                superseded = true;
                data = {
                  ...stored,
                  discovery: {
                    ...peerDiscovery,
                    events: merged ?? peerEvents,
                  },
                };
                if (merged && (prunedPeer || removals?.changed))
                  withRemovals = {
                    ...stored,
                    discovery: {
                      ...peerDiscovery,
                      events: peerEvents,
                    },
                  };
                mergedUpdates = !!merged;
              }
              if (observedDiscovery === undefined) observedDiscovery = current;
            }
            const meta = {
              key: scope,
              bytes: byteSize(data),
              savedAt: superseded ? row.savedAt : Date.now(),
            };
            const put = () => {
              if (meta.bytes > MAX_BYTES && revoked) {
                // An oversized replacement must still remove the revoked roster.
                delete data.discovery;
                meta.bytes = byteSize(data);
              }
              if (meta.bytes > MAX_BYTES) {
                done("oversized");
                return false;
              }
              if (patch.discovery) version = discoveryVersion(data.discovery);
              store.put({ ...meta, data });
              return true;
            };
            const prune = (rows: RowBudget[]) => {
              const kept = pruneStartupBudget(store, rows).includes(meta);
              if (superseded && !kept) version = null;
              done(superseded ? undefined : kept);
            };
            if (!mergedUpdates && !(sameRelay && removals?.changed)) {
              if (put()) readStartupBudget(store, then, prune, meta);
              return;
            }
            readStartupBudget(
              store,
              then,
              (rows) => {
                const room = rows.reduce(
                  (room, row) =>
                    row === meta || isMirror(row) ? room : room - row.bytes,
                  MAX_BYTES,
                );
                // Grants and extra removal versions must fit beside existing
                // rosters. Removing a stale peer grant takes priority.
                if (meta.bytes > room && withRemovals) {
                  data = withRemovals;
                  meta.bytes = byteSize(data);
                }
                if (
                  meta.bytes > room &&
                  removals?.changed &&
                  peer &&
                  data.discovery
                ) {
                  prunedPeer ??=
                    removalFor && pruneRevokedRosters(peer, removalFor);
                  if (prunedPeer) {
                    const removed = prunedPeer.removed;
                    const required = signedRemovalVersions(
                      peer.removals,
                      [...removals.versions.values()].filter((removal) =>
                        removed.has(removal.channel),
                      ),
                    );
                    data.discovery.removals = [...required.versions.values()];
                  } else {
                    delete data.discovery.removals;
                    if (peer.removals) data.discovery.removals = peer.removals;
                  }
                  meta.bytes = byteSize(data);
                }
                if (meta.bytes > room && !prunedPeer) {
                  if (superseded) return done(undefined);
                  if (meta.bytes > MAX_BYTES)
                    return done("oversized-with-clean-roster");
                }
                if (put()) prune(rows);
              },
              meta,
            );
          }),
        STARTUP,
      );
      if (saved === undefined) {
        const peerVersion = version;
        throw new StartupRosterSuperseded(
          peerVersion
            ? () => {
                observedDiscovery = peerVersion;
                observedPeer = true;
              }
            : undefined,
        );
      }
      if (saved === "oversized" || saved === "oversized-with-clean-roster")
        throw new StartupCacheOverBudget(
          saved === "oversized-with-clean-roster",
        );
      if (!saved) throw new Error("Startup cache is over its byte budget");
      if (version !== undefined) {
        observedDiscovery = version;
        observedPeer = false;
      }
    },
    readProfiles: () =>
      transact(
        "readonly",
        (store, done, then) =>
          then(store.get(profiles), (row) => done(row?.data ?? [])),
        STARTUP,
      ),
    writeProfiles: (events, optional = []) =>
      transact(
        "readwrite",
        (store, done, then) =>
          readStartupBudget(store, then, (rows) => {
            // Rows outranking this newest mirror keep their room.
            const others = rows.filter((row) => row.key !== profiles);
            const room =
              MAX_BYTES -
              others.reduce(
                (sum, row) => (isMirror(row) ? sum : sum + row.bytes),
                0,
              );
            let bytes = byteSize(events);
            const kept: unknown[] = [];
            for (const event of [...optional].reverse()) {
              // Its bytes, plus a comma once the list holds any.
              const size = byteSize(event) + (bytes > 2 ? 1 : 0);
              if (bytes + size > room) continue;
              bytes += size;
              kept.push(event);
            }
            if (bytes <= MAX_BYTES) {
              const row = { key: profiles, bytes, savedAt: Date.now() };
              store.put({ ...row, data: [...events, ...kept.reverse()] });
              pruneStartupBudget(store, [...others, row]);
            }
            done(undefined);
          }),
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
      observedPeer = false;
      await transact("readwrite", (store, done, then) =>
        // Include metadata left by a point delete on an older build.
        then(store.getAll(), (rows: ScopedRow[]) => {
          for (const row of rows)
            if (row.scope === scope) store.delete(row.key);
          done(undefined);
        }),
      );
    },
    usage: async () => {
      type Sized = { bytes: number } | undefined;
      const startup = await transact<number>(
        "readonly",
        (store, done, then) =>
          then(store.get(scope), (saved: Sized) =>
            then(store.get(profiles), (mirror: Sized) =>
              done((saved?.bytes ?? 0) + (mirror?.bytes ?? 0)),
            ),
          ),
        STARTUP,
      );
      // Metadata rows carry each head's size without loading its events.
      const heads = await transact<number>("readonly", (store, done, then) =>
        then(
          store.getAll(metadataKeys()),
          (rows: { scope: string; head: RowBudget }[]) =>
            done(
              rows.reduce(
                (total, row) =>
                  row.scope === scope ? total + row.head.bytes : total,
                0,
              ),
            ),
        ),
      );
      return startup + heads;
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
