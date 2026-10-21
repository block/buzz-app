import { fileStore } from "./state";
import { localStore, type AgentStore } from "./store";

/** Storage held in memory. It is also agent storage over the same items,
 * which saves as it is set, so a test can seed and read it either way. */
export function memoryStorage(): Storage & AgentStore {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
  return Object.assign(storage, localStore(storage));
}

/** Agent storage files that programs share. Each program loads its own copy
 * once, as the app does at start, and then saves into them, adding a key
 * only where none is, as the native files do. A held program's saves wait
 * until it is released. */
export function sharedFiles(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial));
  const open = (hold?: Promise<void>) =>
    fileStore(
      new Map(disk),
      async (key, value) => {
        await hold;
        if (value === null) disk.delete(key);
        else disk.set(key, value);
      },
      async (key, value) => {
        await hold;
        const held = disk.get(key);
        if (held !== undefined) return held;
        disk.set(key, value);
        return null;
      },
    );
  return { disk, open };
}

/** Agent storage whose saves wait until a test lands or fails each one,
 * unless `auto` lands it at once. Saved values go to `disk`, which a
 * restart reads. */
export function gatedStore(
  auto: (value: string | null) => boolean = () => false,
) {
  const disk = memoryStorage();
  const writes: { value: string | null; land(): void; fail(): void }[] = [];
  const store: Pick<AgentStore, "get" | "set"> = {
    get: (key) => disk.get(key),
    set: (key, value) =>
      new Promise<void>((resolve, reject) => {
        const land = () => void disk.set(key, value).then(resolve);
        if (auto(value)) return land();
        writes.push({
          value,
          land,
          fail: () => reject(new Error("disk full")),
        });
      }),
  };
  return { store, disk, writes };
}
