import type { OutboxStorage, OutgoingEvent } from "./outbox";

type Row = { operation: OutgoingEvent };

/** A save would leave the shared journal over its budget. Nothing was written. */
export class OutboxFull extends Error {
  constructor(
    /** Rows this save would have grown. */
    readonly grown: readonly string[],
  ) {
    super("Outbox storage is full");
  }
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-outbox-v2", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("partitions"))
        db.createObjectStore("partitions");
      if (!db.objectStoreNames.contains("events"))
        db.createObjectStore("events", {
          keyPath: ["scope", "id"],
        }).createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to upgrade the outbox"));
  });
}

/** Drops one partition's journal, including its legacy record, after that
 * community's session is disposed: nothing left there can still be delivered. */
export async function purgeOutboxStorage(scope: string) {
  localStorage.removeItem(`buzz-outbox-v1:${scope}`);
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["events", "partitions"], "readwrite", {
        durability: "strict",
      });
      const events = tx.objectStore("events");
      const keys = events.index("scope").getAllKeys(IDBKeyRange.only(scope));
      keys.onsuccess = () => {
        for (const key of keys.result) events.delete(key);
      };
      tx.objectStore("partitions").delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Outbox purge aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Incremental asynchronous journal, atomically partitioned by relay and viewer. */
export function browserOutboxStorage(scope: string): OutboxStorage {
  let database: Promise<IDBDatabase> | undefined;
  let persisted = new Map<string, OutgoingEvent>();
  let legacyRows = new Map<string, OutgoingEvent>();
  let ownershipRevision = 0;
  const forgotten = new Map<string, number>();
  const open = () => (database ??= openDatabase());
  const name = (id: string) => `buzz-outbox:${scope}:${id}`;
  // A window publishing a Canvas or recipe save holds that save's lock, so a
  // held lock means the save is in progress. Resolves to its release.
  const reserve = (id: string) =>
    new Promise<() => void>((resolve, reject) => {
      navigator.locks
        .request(name(id), { ifAvailable: true }, (lock) => {
          if (!lock)
            throw new Error("This save is in progress in another window.");
          return new Promise<void>((release) => resolve(release));
        })
        .catch(reject);
    });
  return {
    async lock(id, run) {
      if (!navigator.locks) throw new Error("Window ownership is unavailable.");
      return navigator.locks.request(name(id), run);
    },
    forget(id) {
      forgotten.set(id, ++ownershipRevision);
      persisted.delete(id);
      legacyRows.delete(id);
    },
    async load(options) {
      const db = await open();
      let migrated = false;
      const records = await new Promise<readonly OutgoingEvent[]>(
        (resolve, reject) => {
          const tx = db.transaction(["events", "partitions"]);
          const entries = tx
            .objectStore("events")
            .index("scope")
            .getAll(IDBKeyRange.only(scope));
          const legacy = tx.objectStore("partitions").get(scope);
          tx.oncomplete = () => {
            try {
              migrated = legacy.result === true;
              const values = entries.result.map((row: Row) => row.operation);
              // The marker distinguishes a migrated empty journal from an un-migrated one.
              resolve(
                values.length || legacy.result === true
                  ? values
                  : (legacy.result ??
                      JSON.parse(
                        localStorage.getItem(`buzz-outbox-v1:${scope}`) ?? "[]",
                      )),
              );
            } catch (error) {
              reject(error);
            }
          };
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        },
      );
      // A first save migrates legacy records into the per-event store.
      if (!options?.readOnly) {
        persisted = migrated
          ? new Map(records.map((item) => [item.event.id, item]))
          : new Map();
        legacyRows = new Map(
          migrated ? [] : records.map((item) => [item.event.id, item]),
        );
      }
      return records;
    },
    async save(operations, options) {
      const revision = ownershipRevision;
      const db = await open();
      const retired = options?.retired ?? [];
      if (retired.length && !navigator.locks)
        throw new Error("Window ownership is unavailable.");
      const releases: (() => void)[] = [];
      const release = () => {
        for (const done of releases) done();
      };
      try {
        for (const id of retired) releases.push(await reserve(id));
      } catch (error) {
        release();
        throw error;
      }
      const next = new Map(operations.map((item) => [item.event.id, item]));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["events", "partitions"], "readwrite", {
          durability: "strict",
        });
        const events = tx.objectStore("events");
        const partitions = tx.objectStore("partitions");
        const migration = legacyRows.size ? partitions.get(scope) : undefined;
        const migrated = () => migration?.result === true;
        // Checked before this transaction deletes them.
        let refusal: Error | undefined;
        const keep = new Set(options?.keep);
        const stays = (id: string) => keep.has(id) && !next.has(id);
        // A row is written unconditionally, or only over a stored copy, or,
        // for a legacy row with no stored copy, only before migration.
        type Write = {
          operation: OutgoingEvent;
          always: boolean;
          overStored: boolean;
          legacy: boolean;
        };
        const lands = (write: Write, stored: boolean) =>
          write.always ||
          (stored ? write.overStored : write.legacy && !migrated());
        const writes = new Map<string, Write>();
        for (const [id, operation] of next) {
          const old = persisted.get(id);
          if (
            id !== options?.force &&
            old &&
            old.delivery === operation.delivery &&
            old.error === operation.error &&
            old.refused === operation.refused &&
            old.acknowledged === operation.acknowledged &&
            old.signed?.id === operation.signed?.id &&
            old.recovery?.key === operation.recovery?.key &&
            old.recovery?.value === operation.recovery?.value &&
            old.guarded === operation.guarded
          )
            continue;
          const legacy = !old && legacyRows.has(id);
          writes.set(id, {
            operation,
            always: id === options?.force || (!old && !legacy),
            overStored: true,
            legacy,
          });
        }
        // Migration retires the legacy record, so a kept legacy row needs its
        // own copy, unless another window already gave it one.
        for (const [id, operation] of legacyRows)
          if (stays(id))
            writes.set(id, {
              operation,
              always: false,
              overStored: false,
              legacy: true,
            });
        const deletes = [...persisted.keys(), ...legacyRows.keys()].filter(
          (id) => !next.has(id) && !keep.has(id),
        );
        for (const id of retired) {
          const row = events.get([scope, id]);
          row.onsuccess = () => {
            const found: Row | undefined = row.result;
            if (found === undefined) {
              // This window never saved it, so no other window replaced it.
              if (!persisted.has(id) && !legacyRows.has(id)) return;
              if (legacyRows.has(id) && !migrated()) return;
              refusal = new Error(
                "This save was replaced in another window. Try again.",
              );
            } else if (found.operation.recovery)
              refusal = new Error(
                "This save is in progress in another window.",
              );
            else return void events.delete([scope, id]);
            tx.abort();
          };
        }
        // Another window may have changed or removed a written row, so each
        // one is read in this transaction before anything is written.
        const current = new Map<string, OutgoingEvent | undefined>();
        const commit = () => {
          for (const [id, write] of writes)
            if (lands(write, current.get(id) !== undefined))
              events.put({ scope, id, operation: write.operation });
          for (const id of deletes) events.delete([scope, id]);
          partitions.put(true, scope);
        };
        const budget = options?.budget;
        // Reading every stored row is costly, so only a save that grows a row
        // as it is stored now checks the budget.
        const check = () => {
          const grown = budget
            ? [...writes]
                .filter(
                  ([id, write]) =>
                    lands(write, current.get(id) !== undefined) &&
                    budget.grows(
                      current.get(id) ??
                        (migrated() ? undefined : legacyRows.get(id)),
                      write.operation,
                    ),
                )
                .map(([id]) => id)
            : [];
          if (!budget || !grown.length) return commit();
          const stored = events.index("scope").getAll(IDBKeyRange.only(scope));
          stored.onsuccess = () => {
            const after = new Map<string, OutgoingEvent>(
              stored.result.map((row: Row) => [
                row.operation.event.id,
                row.operation,
              ]),
            );
            for (const id of [...deletes, ...retired]) after.delete(id);
            for (const [id, write] of writes)
              if (lands(write, current.get(id) !== undefined))
                after.set(id, write.operation);
            if (budget.fits([...after.values()])) return commit();
            refusal = new OutboxFull(grown);
            tx.abort();
          };
        };
        let reads = writes.size;
        if (!reads) check();
        for (const id of writes.keys()) {
          const row = events.get([scope, id]);
          row.onsuccess = () => {
            current.set(id, (row.result as Row | undefined)?.operation);
            if (!--reads) check();
          };
        }
        tx.oncomplete = () => {
          // A read can relinquish an ID while this transaction is pending.
          // Do not let completion reclaim deletion ownership of that ID.
          // Rows left as stored keep their last saved copy.
          const untouched = [...persisted, ...legacyRows].filter(([id]) =>
            stays(id),
          );
          persisted = new Map(
            [...untouched, ...next].filter(
              ([id]) => (forgotten.get(id) ?? 0) <= revision,
            ),
          );
          legacyRows.clear();
          resolve();
        };
        tx.onabort = () =>
          reject(
            refusal ?? tx.error ?? new Error("Outbox transaction aborted"),
          );
        tx.onerror = () => {
          if (!refusal) reject(tx.error);
        };
      }).finally(release);
    },
    close() {
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
