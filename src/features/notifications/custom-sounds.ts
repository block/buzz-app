import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "./preferences";

/** A sound file chosen for one row in Settings, copied into this device. */
export type CustomSound = Readonly<{
  category: NotificationCategory;
  name: string;
  audio: Blob;
}>;
export type CustomSoundStore = Readonly<{
  load(): Promise<readonly CustomSound[]>;
  save(sound: CustomSound): Promise<void>;
}>;

const DATABASE = "buzz-custom-sounds-v1";
const STORE = "sounds";

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "category" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to save a sound file."));
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** Device-wide, like the browser storage it lives in; accounts share it. */
export function createCustomSoundStore(): CustomSoundStore {
  return {
    async load() {
      if (typeof indexedDB === "undefined") return [];
      const rows = await run("readonly", (store) => store.getAll());
      return rows.filter(
        (row): row is CustomSound =>
          NOTIFICATION_CATEGORIES.includes(row?.category) &&
          typeof row.name === "string" &&
          row.audio instanceof Blob,
      );
    },
    async save(sound) {
      if (typeof indexedDB === "undefined")
        throw new Error("This build can’t save sound files.");
      await run("readwrite", (store) => store.put(sound));
    },
  };
}
