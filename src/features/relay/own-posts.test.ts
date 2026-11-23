import { expect, it, vi } from "vitest";
import { createOwnPosts, OWN_POSTS_LIMIT } from "./own-posts";
import type { ReadFilter, RelayEvent } from "./events";
import { keypair, message } from "./testing";

function setup() {
  const viewer = keypair();
  const peer = keypair();
  const pending: {
    filters: readonly ReadFilter[];
    signal: AbortSignal | undefined;
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const read = vi.fn(
    (filters: readonly ReadFilter[], options?: { signal?: AbortSignal }) =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        pending.push({ filters, signal: options?.signal, resolve, reject }),
      ),
  );
  const store = createOwnPosts({ viewer: viewer.pubkey, reader: { read } });
  return { viewer, peer, pending, read, store };
}

it("reads the viewer's own recent messages once and lists the channels they name", async () => {
  const h = setup();
  expect(h.store.snapshot().status).toBe("idle");
  const first = h.store.ensure();
  expect(h.store.ensure()).toBe(first);
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.pending[0]?.filters).toEqual([
    expect.objectContaining({
      authors: [h.viewer.pubkey],
      limit: OWN_POSTS_LIMIT,
      kinds: expect.arrayContaining([9]),
    }),
  ]);
  expect(h.store.snapshot().status).toBe("loading");
  h.pending[0]?.resolve([
    message(h.viewer, "alpha", "mine", 10),
    message(h.viewer, "alpha", "again", 11),
    message(h.viewer, "beta", "mine", 12),
    // Someone else's message, or one that names no single channel, is not a post.
    message(h.peer, "gamma", "theirs", 13),
    message(h.viewer, "delta", "two", 14, [["h", "epsilon"]]),
  ]);
  await first;
  expect(h.store.snapshot()).toEqual({
    status: "ready",
    channels: new Set(["alpha", "beta"]),
  });
  await h.store.ensure();
  expect(h.read).toHaveBeenCalledOnce();
});

it("adds a channel the moment the viewer's own message is accepted, and notifies once", async () => {
  const h = setup();
  const listener = vi.fn();
  h.store.subscribe(listener);
  const reading = h.store.ensure();
  h.pending[0]?.resolve([message(h.viewer, "alpha", "mine", 10)]);
  await reading;
  listener.mockClear();
  const before = h.store.snapshot();
  h.store.accept([message(h.peer, "beta", "theirs", 20)]);
  expect(h.store.snapshot()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
  h.store.accept([message(h.viewer, "beta", "send", 21)]);
  expect(h.store.snapshot().channels).toEqual(new Set(["alpha", "beta"]));
  expect(listener).toHaveBeenCalledOnce();
  // A channel already listed changes nothing.
  const after = h.store.snapshot();
  h.store.accept([message(h.viewer, "beta", "send again", 22)]);
  expect(h.store.snapshot()).toBe(after);
  expect(listener).toHaveBeenCalledOnce();
});

it("keeps a send accepted while the read was out, which the read may predate", async () => {
  const h = setup();
  const reading = h.store.ensure();
  h.store.accept([message(h.viewer, "fresh", "sent meanwhile", 30)]);
  expect(h.store.snapshot().channels.size).toBe(0);
  h.pending[0]?.resolve([message(h.viewer, "alpha", "mine", 10)]);
  await reading;
  expect(h.store.snapshot().channels).toEqual(new Set(["alpha", "fresh"]));
});

it("reports a failed read and reads again when asked", async () => {
  const h = setup();
  const failed = h.store.ensure();
  h.pending[0]?.reject(new Error("offline"));
  await failed;
  expect(h.store.snapshot()).toMatchObject({ status: "error" });
  const retry = h.store.ensure();
  expect(h.read).toHaveBeenCalledTimes(2);
  h.pending[1]?.resolve([message(h.viewer, "alpha", "mine", 10)]);
  await retry;
  expect(h.store.snapshot()).toEqual({
    status: "ready",
    channels: new Set(["alpha"]),
  });
});

it("forgets everything on clear and drops a read still out", async () => {
  const h = setup();
  const reading = h.store.ensure();
  h.store.clear();
  expect(h.pending[0]?.signal?.aborted).toBe(true);
  h.pending[0]?.resolve([message(h.viewer, "alpha", "late", 10)]);
  await reading;
  expect(h.store.snapshot()).toEqual({ status: "idle", channels: new Set() });
  const again = h.store.ensure();
  h.pending[1]?.resolve([message(h.viewer, "beta", "mine", 11)]);
  await again;
  expect(h.store.snapshot().channels).toEqual(new Set(["beta"]));
});

it("is unavailable without a reader and never reads", async () => {
  const viewer = keypair();
  const store = createOwnPosts({ viewer: viewer.pubkey, reader: undefined });
  await store.ensure();
  store.accept([message(viewer, "alpha", "mine", 10)]);
  expect(store.snapshot()).toEqual({
    status: "unavailable",
    channels: new Set(),
  });
});
