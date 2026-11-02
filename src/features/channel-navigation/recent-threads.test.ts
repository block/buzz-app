import { expect, it, vi } from "vitest";
import { createThreadNavigation, type ThreadRecord } from "./recent-threads";
import type { ChannelMessage } from "../relay/contracts";

const root = (content = "Planning"): ChannelMessage => ({
  id: "a".repeat(64),
  channelId: "general",
  authorId: "b".repeat(64),
  content,
  createdAt: 1,
  replyCount: 0,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
});
function gate<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const idle = (store: ReturnType<typeof createThreadNavigation>) =>
  new Promise<void>((resolve) => {
    if (!store.snapshot().pending.length) return resolve();
    const stop = store.subscribe(() => {
      if (!store.snapshot().pending.length) {
        stop();
        resolve();
      }
    });
  });

it.each([false, true])(
  "keeps native titles well formed at the UTF-16 boundary (attachment=%s)",
  async (attachment) => {
    const title = `${"x".repeat(159)}😀`;
    const write = vi.fn(async (record: ThreadRecord) => record);
    const store = createThreadNavigation(
      { read: async () => [], write },
      new AbortController().signal,
    );
    try {
      store.visit(
        attachment
          ? {
              ...root(""),
              attachments: [
                { kind: "file", url: "https://example.test/file", name: title },
              ],
            }
          : root(title),
      );
      await idle(store);
      expect(store.snapshot().entries[0]?.title).toBe("x".repeat(159));
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      store.dispose();
    }
  },
);

it("clearing the session fences a late read and a dispatched write, and permits new work", async () => {
  const read = gate<readonly ThreadRecord[]>();
  const write = gate<ThreadRecord>();
  const started = gate<ThreadRecord>();
  const host = {
    read: () => read.promise,
    write: vi.fn((record: ThreadRecord) => {
      started.resolve(record);
      return write.promise;
    }),
  };
  const store = createThreadNavigation(host, new AbortController().signal);
  try {
    const refresh = store.refresh();
    store.visit(root());
    const record = await started.promise;
    store.clear();
    read.resolve([record]);
    write.resolve(record);
    await refresh;
    host.write.mockImplementation(async (value) => value);
    store.visit({ ...root("New scope visit"), id: "c".repeat(64) });
    await idle(store);
    expect(store.snapshot().entries.map((entry) => entry.title)).toEqual([
      "New scope visit",
    ]);
  } finally {
    read.resolve([]);
    store.dispose();
  }
});

it("a stale refresh cannot roll back a confirmed pin and retry retains every failed visit", async () => {
  let time = 1000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => ++time);
  const held = gate<readonly ThreadRecord[]>();
  const host = {
    read: () => held.promise,
    write: vi.fn(async (record: ThreadRecord) => record),
  };
  const store = createThreadNavigation(host, new AbortController().signal);
  try {
    const refresh = store.refresh();
    store.visit(root());
    await idle(store);
    const entry = store.snapshot().entries[0];
    if (!entry) throw new Error("Missing thread");
    store.pin(entry, true);
    await idle(store);
    held.resolve([]);
    await refresh;
    expect(store.snapshot().entries[0]?.pinned).toBeGreaterThan(0);
    host.write
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    store.visit(root("Updated title"));
    store.visit({ ...root("Second thread"), id: "c".repeat(64) });
    await idle(store);
    expect(store.snapshot().writeError).toBeDefined();
    store.retry();
    await idle(store);
    expect(store.snapshot().writeError).toBeUndefined();
    expect(store.snapshot().entries.map((row) => row.title)).toEqual([
      "Second thread",
      "Updated title",
    ]);
  } finally {
    clock.mockRestore();
    held.resolve([]);
    store.dispose();
  }
});
