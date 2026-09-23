import { byteSize } from "./budget";

/** Small disposable read-model checkpoints, never durable user intent.
 * One transaction replaces a partition; failures leave the live model usable. */
export interface CheckpointStorage {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_SCOPES = 8;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
type Stored = { value: unknown; savedAt: number; bytes: number };

export function browserCheckpointStorage(scope: string): CheckpointStorage {
  let closed = false;
  let opening: Promise<IDBDatabase> | undefined;
  function open() {
    if (closed || typeof indexedDB === "undefined")
      return Promise.reject(new Error("Local cache unavailable"));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("buzz-read-models-v1", 1);
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error("Local cache open timed out"));
      }, 1500);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("scopes");
      request.onerror = request.onblocked = () => {
        expired = true;
        clearTimeout(timer);
        reject(new Error("Local cache unavailable"));
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (closed || expired) {
          request.result.close();
          reject(new Error("Local cache closed"));
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return opening;
  }
  async function transaction(
    mode: IDBTransactionMode,
    value?: unknown,
    remove = false,
  ) {
    const db = await open();
    if (closed) throw new Error("Local cache closed");
    return new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("scopes", mode);
      const store = tx.objectStore("scopes");
      const request =
        mode === "readonly"
          ? store.get(scope)
          : remove
            ? store.delete(scope)
            : store.put(
                {
                  value,
                  savedAt: Date.now(),
                  bytes: byteSize(value),
                } satisfies Stored,
                scope,
              );
      if (mode === "readwrite" && !remove) {
        // One transaction owns replacement and the global cross-scope budget.
        const entries: { key: IDBValidKey; savedAt: number; bytes: number }[] =
          [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (entry) {
            const row = entry.value as Stored;
            entries.push({
              key: entry.key,
              savedAt: row.savedAt,
              bytes: row.bytes,
            });
            entry.continue();
            return;
          }
          let bytes = 0;
          entries
            .sort(
              (a, b) =>
                Number(b.key === scope) - Number(a.key === scope) ||
                b.savedAt - a.savedAt,
            )
            .forEach((row, index) => {
              bytes += row.bytes;
              if (index >= MAX_SCOPES || bytes > MAX_TOTAL_BYTES)
                store.delete(row.key);
            });
        };
      }
      const timer = setTimeout(() => tx.abort(), 2000);
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve(
          mode === "readonly"
            ? (request.result as Stored | undefined)?.value
            : undefined,
        );
      };
      tx.onabort = tx.onerror = () => {
        clearTimeout(timer);
        reject(tx.error ?? new Error("Local cache transaction failed"));
      };
    });
  }
  return {
    read: () => transaction("readonly"),
    write: async (value) => {
      await transaction(
        "readwrite",
        value,
        byteSize(value) > MAX_CHECKPOINT_BYTES,
      );
    },
    clear: async () => {
      await transaction("readwrite", undefined, true);
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
