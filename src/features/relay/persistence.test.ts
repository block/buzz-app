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

/** A store whose `put` throws like a finished transaction once `active` is off. */
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
  // WebKit delivers a request's already-queued success event after abort(),
  // before the abort event. A follow-up request issued from that handler
  // throws synchronously, outside any promise, and so surfaces as a page error.
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
  // The browser can abort before this module's timeout and still deliver the
  // queued success first, so nothing here has set `ended` yet. The follow-up
  // put throws TransactionInactiveError; the handler must not let it escape,
  // and the abort event that follows settles the operation.
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(() => {}, writeStartup, store);
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  // Let the open settle and the work issue its get, short of the 2 s abort.
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
