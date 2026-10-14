import { afterEach, expect, it, vi } from "vitest";
import { createHeadPersistence } from "./persistence";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function transaction(abort: () => void) {
  const tx = {
    abort: vi.fn(abort),
    error: null,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore: () => ({ delete: vi.fn() }),
  };
  const request = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  const cache = createHeadPersistence("viewer", "relay");
  const result = cache.remove("channel");
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

function startupTransaction() {
  const read = { result: undefined, onsuccess: () => {} };
  const store = {
    get: vi.fn(() => read),
    put: vi.fn(),
    getAll: vi.fn(),
  };
  const tx = {
    abort: vi.fn(() => tx.onabort()),
    error: null,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore: () => store,
  };
  const opening = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => opening });
  const cache = createHeadPersistence("viewer", "relay");
  if (!cache.writeStartup) throw new Error("Missing startup persistence");
  const result = cache.writeStartup({
    discovery: { savedAt: 0, relayAuthor: "relay", events: [] },
  });
  opening.onsuccess();
  return { read, store, tx, result };
}

it("rejects a native write failure delivered in a startup request callback", async () => {
  vi.useFakeTimers();
  const { read, store, tx, result } = startupTransaction();
  const failure = new DOMException(
    "The transaction has finished",
    "TransactionInactiveError",
  );
  store.put.mockImplementation(() => {
    throw failure;
  });
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get).toHaveBeenCalledOnce();
  expect(() => read.onsuccess()).not.toThrow();
  await rejected;
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "retires a pending startup callback when the deadline races native completion=%s",
  async (finished) => {
    vi.useFakeTimers();
    const { read, store, tx, result } = startupTransaction();
    const failure = new DOMException(
      "The transaction has finished",
      "TransactionInactiveError",
    );
    store.put.mockImplementation(() => {
      throw failure;
    });
    if (finished)
      tx.abort.mockImplementation(() => {
        throw new DOMException(
          "The transaction has finished",
          "InvalidStateError",
        );
      });
    const rejected = expect(result).rejects.toThrow(
      finished
        ? "Cache transaction completed before its work"
        : "Cache transaction aborted",
    );
    await vi.advanceTimersByTimeAsync(2000);
    if (finished) tx.oncomplete();
    await rejected;
    expect(() => read.onsuccess()).not.toThrow();
    expect(store.put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
