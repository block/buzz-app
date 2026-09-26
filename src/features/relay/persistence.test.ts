import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import { HEAD_MAX_AGE } from "./budget";
import { createHeadPersistence, type SavedHead } from "./persistence";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
const saved = (
  channelId: string,
  savedAt = Date.now(),
  bytes = 0,
): SavedHead => ({
  channelId,
  savedAt,
  events: bytes ? ["x".repeat(bytes)] : [],
  profiles: [],
});
const ids = (heads: readonly SavedHead[]) =>
  heads.map((head) => head.channelId);
function open(version: number, upgrade?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-channel-heads-v1", version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
/** Writes records as stored rows directly, one transaction for a large fixture. */
async function seed(scope: string, heads: readonly SavedHead[], version = 3) {
  // Legacy layouts: version 1 had only heads; version 2 added the startup store.
  const db = await open(version, (db) => {
    db.createObjectStore("heads", { keyPath: "key" });
    if (version === 2) db.createObjectStore("startup", { keyPath: "key" });
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("heads", "readwrite");
    for (const head of heads)
      tx.objectStore("heads").put({
        ...head,
        key: `${scope}:${head.channelId}`,
        scope,
        bytes: 100,
      });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

it("keeps a window saved days ago and drops one past the retention backstop", async () => {
  const disk = createHeadPersistence("viewer", "relay");
  await disk.write(saved("recent", Date.now() - 3 * 86_400_000));
  await disk.write(saved("abandoned", Date.now() - HEAD_MAX_AGE - 1000));
  expect(ids(await disk.read())).toEqual(["recent"]);
  disk.close();
});

it("enforces the global budget newest first without reading other scopes", async () => {
  const mine = createHeadPersistence("viewer", "relay");
  const theirs = createHeadPersistence("other", "relay");
  const start = Date.now() - 1_000_000;
  await theirs.write(saved("theirs", start));
  await seed(
    "viewer:relay",
    Array.from({ length: 255 }, (_, index) =>
      saved(`c${index}`, start + 1 + index),
    ),
  );
  await mine.write(saved("c255", start + 256));
  // 257 records over a 256-record budget: the oldest, another identity's, goes first.
  expect(await theirs.read()).toEqual([]);
  expect(await mine.read()).toHaveLength(256);
  // Byte budget: the newest window is kept, older ones past 16 MiB are evicted.
  await mine.write(saved("large", start + 1000, 9 * 1024 * 1024));
  expect(await mine.read()).toHaveLength(256);
  await mine.write(saved("larger", start + 1001, 9 * 1024 * 1024));
  expect(ids(await mine.read())).toEqual(["larger"]);
  mine.close();
  theirs.close();
});

it("retains and clears only this scope", async () => {
  const mine = createHeadPersistence("viewer", "relay");
  const theirs = createHeadPersistence("viewer", "relay:8080");
  await mine.write(saved("a"));
  await mine.write(saved("b"));
  await theirs.write(saved("a"));
  await mine.retain(["b"]);
  expect(ids(await mine.read())).toEqual(["b"]);
  expect(ids(await theirs.read())).toEqual(["a"]);
  await mine.clear();
  expect(await mine.read()).toEqual([]);
  expect(ids(await theirs.read())).toEqual(["a"]);
  mine.close();
  theirs.close();
});

it.each([1, 2])(
  "upgrades a version %i cache in place without losing saved windows",
  async (version) => {
    await seed("viewer:relay", [saved("a")], version);
    const disk = createHeadPersistence("viewer", "relay");
    expect(ids(await disk.read())).toEqual(["a"]);
    await disk.write(saved("b"));
    expect(ids(await disk.read()).sort()).toEqual(["a", "b"]);
    await disk.writeStartup?.({
      preferences: {
        savedAt: Date.now(),
        data: { sections: [], assignments: {}, starred: [], muted: [] },
      },
    });
    expect(await disk.readStartup?.()).toHaveProperty("preferences");
    disk.close();
  },
);
