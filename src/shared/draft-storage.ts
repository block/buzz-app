export type RetirementHistory = [number, ...string[]];
export type DraftRecord = {
  scope: string;
  key: string;
  revision: string | null;
  history?: RetirementHistory;
};

const viewPrefix = "buzz-view.v1:";
const retirementPrefix = "buzz-ret.v1:";
const purgePrefix = "buzz-view-purge.v1:";

// The empty key holds the scope's purge token.
const purgeKey = "";

export function isStoredDraft(key: string) {
  if (key.endsWith(":files")) key = key.slice(0, -":files".length);
  return (
    /^draft:[^:]+(?::thread:[^:]+(?::subthread:[^:]+)?)?$/.test(key) ||
    key === "direct-message:new-draft" ||
    /^solo(?::.*)?:new-draft$/.test(key)
  );
}

function legacyDrafts() {
  const records = new Map<string, DraftRecord>();
  const imported = new Map<string, string>();
  const get = (scope: string, key: string) => {
    const id = JSON.stringify([scope, key]);
    let record = records.get(id);
    if (!record) {
      record = { scope, key, revision: null };
      records.set(id, record);
    }
    return record;
  };
  for (let index = 0; index < localStorage.length; index++) {
    const entry = localStorage.key(index);
    const prefix = [viewPrefix, retirementPrefix, purgePrefix].find((prefix) =>
      entry?.startsWith(prefix),
    );
    if (!entry || !prefix) continue;
    const raw = localStorage.getItem(entry);
    if (raw === null) continue;
    let coordinate: unknown;
    try {
      coordinate = JSON.parse(entry.slice(prefix.length));
    } catch {
      continue;
    }
    if (prefix === purgePrefix && typeof coordinate === "string") {
      get(coordinate, purgeKey).revision = raw;
    } else if (
      Array.isArray(coordinate) &&
      coordinate.length === 2 &&
      typeof coordinate[0] === "string" &&
      typeof coordinate[1] === "string" &&
      isStoredDraft(coordinate[1])
    ) {
      const record = get(coordinate[0], coordinate[1]);
      if (prefix === viewPrefix) record.revision = raw;
      else {
        try {
          const history: unknown = JSON.parse(raw);
          if (
            Array.isArray(history) &&
            Number.isSafeInteger(history[0]) &&
            history.slice(1).every((digest) => typeof digest === "string")
          )
            record.history = history as RetirementHistory;
        } catch {
          // A damaged history does not prevent migration of the draft.
        }
      }
    } else continue;
    imported.set(entry, raw);
  }
  return { records, imported };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-drafts-v1", 1);
    let imported: Map<string, string> | undefined;
    request.onupgradeneeded = () => {
      const drafts = request.result.createObjectStore("drafts", {
        keyPath: ["scope", "key"],
      });
      drafts.createIndex("scope", "scope");
      try {
        const legacy = legacyDrafts();
        for (const record of legacy.records.values()) drafts.put(record);
        imported = legacy.imported;
      } catch (error) {
        request.transaction?.abort();
        reject(error);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      // Only drop the copy after the upgrade transaction commits. A later
      // legacy write has a different revision and is left alone.
      try {
        for (const [key, value] of imported ?? [])
          if (localStorage.getItem(key) === value) localStorage.removeItem(key);
      } catch {
        // Database existence records migration even if cleanup is unavailable.
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

export function createDraftStorage(
  notify: (scope: string, key?: string) => void,
) {
  const database = openDatabase();
  const scopes = new Map<string, Map<string, DraftRecord>>();
  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel("buzz-drafts-v1");

  function apply(record: DraftRecord) {
    let scope = scopes.get(record.scope);
    if (!scope) {
      scope = new Map();
      scopes.set(record.scope, scope);
    }
    scope.set(record.key, record);
  }

  function transaction<T>(
    mode: IDBTransactionMode,
    run: (drafts: IDBObjectStore, done: (value: T) => void) => void,
  ) {
    return database.then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction("drafts", mode, { durability: "strict" });
          let result: T;
          tx.oncomplete = () => resolve(result);
          tx.onabort = () =>
            reject(tx.error ?? new Error("Draft transaction aborted"));
          run(tx.objectStore("drafts"), (value) => {
            result = value;
          });
        }),
    );
  }

  const ready = transaction<DraftRecord[]>("readonly", (drafts, done) => {
    const request = drafts.getAll();
    request.onsuccess = () => done(request.result);
  }).then((records) => {
    for (const record of records) apply(record);
  });

  async function refresh(scope: string, key?: string) {
    if (key !== undefined) {
      const record = await transaction<DraftRecord | undefined>(
        "readonly",
        (drafts, done) => {
          const request = drafts.get([scope, key]);
          request.onsuccess = () => done(request.result);
        },
      );
      const previous = scopes.get(scope)?.get(key);
      if (record) apply(record);
      else scopes.get(scope)?.delete(key);
      if (
        (previous?.revision ?? null) === (record?.revision ?? null) &&
        previous?.history?.[0] === record?.history?.[0]
      )
        return;
    } else {
      const records = await transaction<DraftRecord[]>(
        "readonly",
        (drafts, done) => {
          const request = drafts.index("scope").getAll(scope);
          request.onsuccess = () => done(request.result);
        },
      );
      scopes.delete(scope);
      for (const record of records) apply(record);
    }
    notify(scope, key);
  }

  if (channel)
    channel.onmessage = ({ data }) => {
      if (
        Array.isArray(data) &&
        typeof data[0] === "string" &&
        (data[1] === undefined || typeof data[1] === "string")
      )
        void refresh(data[0], data[1]).catch(() => {});
    };

  return {
    ready,
    record: (scope: string, key: string) => scopes.get(scope)?.get(key),
    entries: (scope: string) => scopes.get(scope)?.values() ?? [],
    purgeToken: (scope: string) =>
      scopes.get(scope)?.get(purgeKey)?.revision ?? null,
    refresh,
    async update<T>(
      scope: string,
      key: string,
      change: (
        record: DraftRecord,
        purgeToken: string | null,
      ) => {
        result: T;
        record?: DraftRecord | undefined;
      },
    ) {
      const next = await transaction<{
        record: DraftRecord;
        purge: DraftRecord | undefined;
        written: boolean;
        result: T;
      }>("readwrite", (drafts, done) => {
        const request = drafts.get([scope, key]);
        const token = drafts.get([scope, purgeKey]);
        token.onsuccess = () => {
          const current = (request.result as DraftRecord | undefined) ?? {
            scope,
            key,
            revision: null,
          };
          const purge: DraftRecord | undefined = token.result;
          const next = change(current, purge?.revision ?? null);
          if (next.record) drafts.put(next.record);
          done({
            record: next.record ?? current,
            purge,
            written: !!next.record,
            result: next.result,
          });
        };
      });
      const previous = scopes.get(scope)?.get(key);
      const previousPurge = scopes.get(scope)?.get(purgeKey)?.revision ?? null;
      apply(next.record);
      if (next.purge) apply(next.purge);
      if (previousPurge !== (next.purge?.revision ?? null)) notify(scope);
      else if (
        next.written ||
        (previous?.revision ?? null) !== next.record.revision ||
        previous?.history?.[0] !== next.record.history?.[0]
      ) {
        notify(scope, key);
      }
      if (next.written) channel?.postMessage([scope, key]);
      return next.result;
    },
    async erase(
      scope: string,
      keys: readonly string[],
      remove: (record: DraftRecord) => DraftRecord,
    ) {
      const erased = await transaction<DraftRecord[]>(
        "readwrite",
        (drafts, done) => {
          const records: DraftRecord[] = [];
          for (const key of keys) {
            const request = drafts.get([scope, key]);
            request.onsuccess = () => {
              const record: DraftRecord | undefined = request.result;
              if (!record || record.revision === null) {
                records.push(record ?? { scope, key, revision: null });
                return;
              }
              const retired = remove(record);
              drafts.put(retired);
              records.push(retired);
            };
          }
          done(records);
        },
      );
      for (const record of erased) apply(record);
      for (const key of keys) {
        notify(scope, key);
        channel?.postMessage([scope, key]);
      }
    },
    async purge(scope: string, token: string) {
      const marker = { scope, key: purgeKey, revision: token };
      await transaction<void>("readwrite", (drafts, done) => {
        const request = drafts.index("scope").getAllKeys(scope);
        request.onsuccess = () => {
          for (const key of request.result) drafts.delete(key);
          drafts.put(marker);
          done();
        };
      });
      scopes.delete(scope);
      apply(marker);
      notify(scope);
      channel?.postMessage([scope]);
    },
  };
}
