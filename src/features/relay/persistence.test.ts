import { afterEach, expect, it, vi } from "vitest";
import { createHeadPersistence, type HeadPersistence } from "./persistence";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Store = Partial<IDBObjectStore>;
function transaction(
  abort: () => void,
  run: (cache: HeadPersistence) => Promise<unknown> = (cache) =>
    cache.remove("channel"),
  store: Store = { delete: vi.fn() },
) {
  const tx = {
    abort: vi.fn(abort),
    error: null,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore: () => store,
  };
  const request = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  const cache = createHeadPersistence("viewer", "relay");
  const result = run(cache);
  request.onsuccess();
  return { tx, result };
}

it("waits for completion when a timeout races an already-finished transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => {
    throw new DOMException("The transaction has finished", "InvalidStateError");
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("still aborts and rejects a genuinely stalled transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => tx.onabort());
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects unexpected abort errors instead of leaving the operation pending", async () => {
  vi.useFakeTimers();
  const failure = new Error("Unexpected abort failure");
  const { result } = transaction(() => {
    throw failure;
  });
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
});

function inactivating() {
  const state = { active: true };
  const get = { onsuccess: () => {}, result: undefined };
  const store: Store = {
    get: vi.fn(() => get as unknown as IDBRequest),
    getAll: vi.fn(),
    put: vi.fn(() => {
      if (state.active) return {} as IDBRequest<IDBValidKey>;
      throw new DOMException(
        "Failed to store record in an IDBObjectStore: The transaction is inactive or finished.",
        "TransactionInactiveError",
      );
    }),
  };
  return { state, get, store };
}
const writeStartup = (cache: HeadPersistence) =>
  cache.writeStartup?.({}) ?? Promise.reject();

it("ignores a request result delivered after the timeout aborted its transaction", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(
    () => {
      state.active = false;
    },
    writeStartup,
    store,
  );
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("swallows a follow-up request thrown by a browser-initiated abort", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(() => {}, writeStartup, store);
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get).toHaveBeenCalledOnce();
  state.active = false;
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).toHaveBeenCalledOnce();
  expect(store.getAll).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(tx.abort).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("evicts the profile mirror before any saved roster", async () => {
  vi.useFakeTimers();
  const MB = 1024 * 1024;
  const rows = {
    onsuccess: () => {},
    result: [
      { key: "viewer:relay", bytes: 6.5 * MB, savedAt: 1 },
      { key: "viewer:relay:profiles", bytes: 2 * MB, savedAt: 2 },
    ],
  };
  const store = {
    put: vi.fn(),
    delete: vi.fn(),
    getAll: () => rows as unknown as IDBRequest,
  };
  const { tx, result } = transaction(
    () => {},
    (cache) => cache.writeProfiles?.([]) ?? Promise.resolve(),
    store,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(store.put).toHaveBeenCalledOnce();
  rows.onsuccess();
  expect(store.delete.mock.calls).toEqual([["viewer:relay:profiles"]]);
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
});

it("keeps saved heads within budget by walking budget keys, never reading heads", async () => {
  vi.useFakeTimers();
  const MB = 1024 * 1024;
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  // Newest first, as the budget index walks backward.
  const keys: [string, [number, number]][] = [
    ["viewer:relay:new", [now, 30 * MB]],
    ["viewer:relay:over", [now - 1, 3 * MB]],
    ["other:relay:small", [now - 2, 1 * MB]],
    ["viewer:relay:stale", [now - day, 1]],
  ];
  const cursor = {
    onsuccess: () => {},
    result: null as IDBCursor | null,
  };
  const step = (index: number) => {
    const entry = keys[index];
    cursor.result = entry
      ? ({
          key: entry[1],
          primaryKey: entry[0],
          continue: () => step(index + 1),
        } as unknown as IDBCursor)
      : null;
  };
  const store = {
    put: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(),
    index: vi.fn(
      () =>
        ({
          openKeyCursor: () => cursor as unknown as IDBRequest,
        }) as unknown as IDBIndex,
    ),
  };
  const { tx, result } = transaction(
    () => {},
    (cache) =>
      cache.write({ channelId: "new", savedAt: now, events: [], profiles: [] }),
    store,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(store.put).toHaveBeenCalledOnce();
  expect(store.index).toHaveBeenCalledWith("budget");
  step(0);
  // Each continue() advances the cursor; the last success has no cursor.
  for (let index = 0; index <= keys.length; index++) cursor.onsuccess();
  expect(store.getAll).not.toHaveBeenCalled();
  expect(store.delete.mock.calls).toEqual([
    ["viewer:relay:over"],
    ["other:relay:small"],
    ["viewer:relay:stale"],
  ]);
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
});

it("reads saved heads newest first, a page per transaction, keeping only this scope", async () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const row = (key: string, scope: string, savedAt: number) => ({
    key,
    scope,
    channelId: key.split(":").at(-1),
    savedAt,
    events: [],
    profiles: [],
    bytes: 1,
  });
  // Index order: oldest first.
  const rows = [
    row("viewer:relay:stale", "viewer:relay", now - day),
    ...Array.from({ length: 40 }, (_, index) =>
      row(`viewer:relay:c${index}`, "viewer:relay", now - 1000 + index),
    ),
    // A longer scope that shares the prefix is read but not kept.
    row("viewer:relay:x:c1", "viewer:relay:x", now),
    row("other:relay:c1", "other:relay", now),
  ];
  const byKey = new Map(rows.map((entry) => [entry.key, entry]));
  const transactions: string[][] = [];
  const answer = <T>(result: T) => {
    const request = { onsuccess: () => {}, result };
    queueMicrotask(() => request.onsuccess());
    return request as unknown as IDBRequest<T>;
  };
  const db = {
    transaction: () => {
      const gets: string[] = [];
      transactions.push(gets);
      const tx = {
        abort: vi.fn(),
        error: null,
        oncomplete: () => {},
        onabort: () => {},
        onerror: () => {},
        objectStore: () => ({
          index: () => ({
            getAllKeys: () => answer(rows.map((entry) => entry.key)),
          }),
          get: (key: string) => {
            gets.push(key);
            return answer(byKey.get(key));
          },
        }),
      };
      setTimeout(() => tx.oncomplete(), 0);
      return tx;
    },
    close: vi.fn(),
  };
  const open = { onsuccess: () => {}, result: db };
  vi.stubGlobal("indexedDB", { open: () => open });
  const cache = createHeadPersistence("viewer", "relay");
  const reading = cache.read();
  open.onsuccess();
  const saved = await reading;
  expect(saved.map((head) => head.channelId)).toEqual(
    Array.from({ length: 40 }, (_, index) => `c${39 - index}`),
  );
  // One key read, then pages of 32 newest first.
  expect(transactions.map((gets) => gets.length)).toEqual([0, 32, 10]);
  expect(transactions[1]?.[0]).toBe("viewer:relay:x:c1");
});
