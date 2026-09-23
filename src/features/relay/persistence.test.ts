import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHeadPersistence } from "./persistence";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("drains admitted write → clear across close while database opening is held", async () => {
  const realOpen = indexedDB.open.bind(indexedDB);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const opened = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(indexedDB, "open").mockImplementationOnce((...args) => {
    const request = realOpen(...args);
    Object.defineProperty(request, "onsuccess", {
      set(callback: (event: Event) => void) {
        request.addEventListener("success", (event) => {
          started();
          void held.then(() => callback(event));
        });
      },
    });
    return request;
  });
  const owner = createHeadPersistence("viewer", "community");
  const writing = owner.write({
    channelId: "alpha",
    savedAt: Date.now(),
    events: [],
    profiles: [],
  });
  await opened;
  const clearing = owner.clear();
  owner.close();
  await expect(
    owner.write({
      channelId: "late",
      savedAt: Date.now(),
      events: [],
      profiles: [],
    }),
  ).rejects.toThrow("Cache closed");
  release();
  await writing;
  await clearing;
  const next = createHeadPersistence("viewer", "community");
  try {
    expect(await next.read()).toEqual([]);
  } finally {
    next.close();
  }
});

it("clears only the selected scope and allows replacement owners after draining", async () => {
  const a = createHeadPersistence("viewer", "a");
  const b = createHeadPersistence("viewer", "b");
  const head = {
    channelId: "alpha",
    savedAt: Date.now(),
    events: [],
    profiles: [],
  };
  await a.write(head);
  await b.write(head);
  const clearing = a.clear();
  a.close();
  await clearing;
  const next = createHeadPersistence("viewer", "a");
  try {
    expect(await next.read()).toEqual([]);
    expect(await b.read()).toHaveLength(1);
  } finally {
    next.close();
    b.close();
  }
});
