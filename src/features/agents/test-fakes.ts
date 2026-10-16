import { fileBacked } from "./state";

export function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

/** Agent storage files that programs share. Each program loads its own copy
 * once, as the app does at start, and then saves into them, adding a key
 * only where none is, as the native files do. A held program's saves wait
 * until it is released. */
export function sharedFiles(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial));
  const open = (hold?: Promise<void>) =>
    fileBacked(
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
