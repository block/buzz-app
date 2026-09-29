import { afterEach, expect, it, vi } from "vitest";
import { browserSidebarStorage } from "./sidebar-journal";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const requests: {
    onsuccess?: () => void;
    onerror?: () => void;
    onblocked?: () => void;
    result: ReturnType<typeof database>;
    error: Error;
  }[] = [];
  function database() {
    const db = {
      close: vi.fn(),
      onversionchange: undefined as (() => void) | undefined,
      transaction: vi.fn(() => {
        const get: { result: unknown; onsuccess?: () => void } = {
          result: undefined,
        };
        const tx = {
          oncomplete: undefined as (() => void) | undefined,
          objectStore: () => ({ get: () => get, put: vi.fn() }),
        };
        queueMicrotask(() => {
          get.onsuccess?.();
          tx.oncomplete?.();
        });
        return tx;
      }),
    };
    return db;
  }
  vi.stubGlobal("indexedDB", {
    open: vi.fn(() => {
      const request = { result: database(), error: new Error("open failed") };
      requests.push(request);
      return request;
    }),
  });
  return { requests };
}
it.each(["onerror", "onblocked"] as const)(
  "reopens after %s and closes any late successful handle",
  async (failure) => {
    const h = fixture(),
      storage = browserSidebarStorage("scope");
    const first = storage.update((j) => j);
    const rejected = expect(first).rejects.toThrow();
    h.requests[0]?.[failure]?.();
    await rejected;
    const next = storage.update((j) => j);
    void next.catch(() => {});
    expect(h.requests).toHaveLength(2);
    h.requests[0]?.onsuccess?.();
    expect(h.requests[0]?.result.close).toHaveBeenCalledOnce();
    h.requests[1]?.onsuccess?.();
    await expect(next).resolves.toEqual({ pending: [], manual: [] });
    expect(h.requests[1]?.result.transaction).toHaveBeenCalledWith(
      "partitions",
      "readwrite",
      { durability: "strict" },
    );
    storage.close();
  },
);
it("keeps the reopened connection owned after a blocked open fails late", async () => {
  const h = fixture(),
    storage = browserSidebarStorage("scope");
  const first = storage.update((j) => j);
  const rejected = expect(first).rejects.toThrow("Close other Buzz windows");
  h.requests[0]?.onblocked?.();
  await rejected;

  const next = storage.update((j) => j);
  expect(h.requests).toHaveLength(2);
  h.requests[0]?.onerror?.();
  h.requests[1]?.onsuccess?.();
  await expect(next).resolves.toEqual({ pending: [], manual: [] });

  storage.close();
  await Promise.resolve();
  expect(h.requests[1]?.result.close).toHaveBeenCalledOnce();
});
it("reopens a version-changed connection and rejects a late open after disposal", async () => {
  const h = fixture(),
    storage = browserSidebarStorage("scope");
  const first = storage.update((j) => j);
  h.requests[0]?.onsuccess?.();
  await first;
  h.requests[0]?.result.onversionchange?.();
  expect(h.requests[0]?.result.close).toHaveBeenCalledOnce();
  const next = storage.update((j) => j);
  expect(h.requests).toHaveLength(2);
  const rejected = expect(next).rejects.toThrow("closed");
  storage.close();
  h.requests[1]?.onsuccess?.();
  await rejected;
  expect(h.requests[1]?.result.close).toHaveBeenCalledOnce();
});
