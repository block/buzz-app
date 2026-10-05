import { describe, expect, it, vi } from "vitest";
import { createChannelStore } from "./store";
import { createProfileDirectory } from "./profile-directory";
import type { OutgoingEvent } from "./outbox";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  signed,
  summary,
} from "./testing";
import type { RelayEvent } from "./events";

const relay = keypair(),
  viewer = keypair(),
  agent = keypair();
function setup(options: Parameters<typeof createChannelStore>[2] = {}) {
  const read = vi.fn(async (): Promise<readonly RelayEvent[]> => []);
  const directory = createProfileDirectory({ read });
  vi.spyOn(directory, "ensure").mockResolvedValue();
  const store = createChannelStore(
    {
      read,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      revokeAccess: (commit) => commit(),
      visible: (events) => events,
    },
    directory,
    options,
  );
  store.acceptDiscovery([
    roster(relay, "a", [viewer.pubkey]),
    metadata(relay, "a", "A"),
    roster(relay, "b", [viewer.pubkey]),
    metadata(relay, "b", "B"),
  ]);
  return {
    store,
    read,
    directory,
    retained: () => store.queries.retained?.() ?? [],
  };
}

describe("passive retained channel evidence", () => {
  it("partitions roots, replies and every overlay BEFORE folding; validates all summary address fields", () => {
    const { store, retained, read, directory } = setup();
    const root = message(viewer, "b", "untouched", 1);
    const reply = message(agent, "b", "reply", 2, [
      ["e", root.id, "", "reply"],
    ]);
    const aux = (kind: number, tags: string[][], content = "wrong") =>
      signed(viewer, { kind, tags, content });
    store.accept([
      root,
      reply,
      message(viewer, "b", "ambiguous", 4, [["h", "a"]]),
      aux(40003, [
        ["h", "a"],
        ["e", root.id],
      ]),
      aux(5, [
        ["h", "a"],
        ["e", root.id],
      ]),
      aux(9005, [
        ["h", "b"],
        ["h", "a"],
        ["e", root.id],
      ]),
      aux(40003, [["e", root.id]]),
      summary(relay, "b", root.id, { participants: [agent.pubkey] }),
      signed(relay, {
        kind: 39005,
        content: "broken JSON",
        created_at: 1_900_000_000,
        tags: [
          ["h", "b"],
          ["e", root.id],
          ["d", root.id],
        ],
      }),
      signed(relay, {
        kind: 39005,
        content: JSON.stringify({ participants: [viewer.pubkey] }),
        created_at: 1_800_000_000,
        tags: [
          ["h", "b"],
          ["e", root.id],
          ["d", reply.id],
        ],
      }),
      summary(relay, "b", reply.id, { participants: [viewer.pubkey] }),
    ]);
    expect(retained()).toHaveLength(2);
    expect(retained().find((row) => row.id === root.id)).toMatchObject({
      excerpt: "untouched",
      participants: [agent.pubkey],
    });
    expect(retained().find((row) => row.id === reply.id)).toMatchObject({
      authorId: agent.pubkey,
      participants: [],
      threadRootId: root.id,
    });
    expect(read).not.toHaveBeenCalled();
    expect(directory.ensure).not.toHaveBeenCalled();
    store.dispose();
  });
  it.each([
    "missing d",
    "duplicate d",
    "duplicate e",
    "extended e",
    "duplicate h",
    "wrong author",
    "malformed",
  ])(
    "rejects %s summaries without hiding valid positive evidence",
    (reason) => {
      const { store, retained } = setup();
      const root = message(viewer, "a", "root", 1);
      let tags = [
        ["h", "a"],
        ["e", root.id],
        ["d", root.id],
      ];
      if (reason === "missing d") tags = tags.slice(0, 2);
      if (reason === "duplicate d") tags.push(["d", root.id]);
      if (reason === "duplicate e") tags.push(["e", root.id]);
      if (reason === "extended e") tags[1]?.push("extra");
      if (reason === "duplicate h") tags.push(["h", "a"]);
      store.accept([
        root,
        signed(reason === "wrong author" ? agent : relay, {
          kind: 39005,
          tags,
          content:
            reason === "malformed"
              ? "not JSON"
              : JSON.stringify({ participants: [agent.pubkey] }),
        }),
      ]);
      expect(retained()[0]?.participants).toEqual([]);
      store.dispose();
    },
  );
  it("combines completed/local acceptance without letting failed local state erase remote proof", () => {
    let operations: readonly OutgoingEvent[] = [];
    let notify = () => {};
    const { store, retained } = setup({
      local: {
        snapshot: () => operations,
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
      },
    });
    const root = message(viewer, "a", "remote", 1);
    const local = message(viewer, "b", "local only", 2);
    store.accept([root]);
    operations = [
      { event: root, delivery: "failed" },
      { event: local, delivery: "accepted" },
      { event: message(viewer, "a", "unknown", 3), delivery: "unknown" },
      { event: message(viewer, "a", "pending", 4), delivery: "sending" },
    ];
    notify();
    expect(
      retained()
        .map((row) => row.id)
        .sort(),
    ).toEqual([root.id, local.id].sort());
    operations = [
      { event: root, delivery: "unknown" },
      { event: local, delivery: "seen" },
    ];
    notify();
    expect(retained()).toHaveLength(2);
    store.denyChannel("b", new Error("denied"));
    expect(retained().map((row) => row.id)).toEqual([root.id]);
    store.dispose();
  });
  it("publishes after commits, coalesces, and cannot resurrect after a listener clears or disposes", async () => {
    const { store, retained } = setup();
    const root = message(viewer, "a", "root", 1);
    const listener = vi.fn(() => {
      expect(retained().map((row) => row.id)).toEqual([root.id]);
      void store.clearCache();
      expect(retained()).toEqual([]);
      store.dispose();
    });
    store.queries.subscribeRetained?.(listener);
    store.accept([root]);
    store.accept([root]);
    expect(listener).not.toHaveBeenCalled();
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    store.accept([root]);
    expect(retained()).toEqual([]);
  });
  it("clears synchronously even when a window subscriber reads during reset; revocation cannot be undone", async () => {
    const { store, retained } = setup();
    const root = message(viewer, "a", "root", 1);
    store.accept([root]);
    store.queries.ensure("a");
    const reads: number[] = [];
    store.queries.subscribeWindow("a", () => reads.push(retained().length));
    void store.clearCache();
    expect(reads).toEqual([0]);
    store.accept([root]);
    const stop = store.queries.subscribeRetained?.(() => {
      stop?.();
      store.denyChannel("a", new Error("denied"));
      expect(retained()).toEqual([]);
    });
    store.accept([root]);
    await flush();
    expect(retained()).toEqual([]);
    store.dispose();
  });
  it("observes silent head eviction with no pinned windows and no passive reads or profile work", async () => {
    const { store, read, retained, directory } = setup({
      prepared: true,
      maxHeads: 1,
    });
    const a = message(viewer, "a", "a", 1),
      b = message(viewer, "b", "b", 2);
    read.mockImplementation(async () => [
      a,
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    const listener = vi.fn();
    store.queries.subscribeRetained?.(listener);
    store.queries.prepare?.("a");
    await flush();
    expect(retained().map((row) => row.id)).toEqual([a.id]);
    const before = retained();
    expect(retained()).toBe(before);
    const counts = [
      read.mock.calls.length,
      vi.mocked(directory.ensure).mock.calls.length,
    ];
    retained();
    retained();
    expect([
      read.mock.calls.length,
      vi.mocked(directory.ensure).mock.calls.length,
    ]).toEqual(counts);
    read.mockImplementation(async () => [
      b,
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    listener.mockClear();
    store.queries.prepare?.("b");
    await flush();
    expect(retained().map((row) => row.id)).toEqual([b.id]);
    expect(listener).toHaveBeenCalled();
    expect(store.queries.window("a").status).toBe("idle");
    store.dispose();
  });
  it("bounds compact output, preserves snapshot identity on irrelevant updates and applies accepted edits/deletes", () => {
    const { store, retained } = setup();
    const root = message(viewer, "a", "x".repeat(1_000_000), 1);
    store.accept([root]);
    const before = retained();
    expect(before[0]?.excerpt).toHaveLength(160);
    expect(before[0]?.titleSource).toHaveLength(161);
    expect(JSON.stringify(before).length).toBeLessThan(1024);
    expect(Object.isFrozen(before)).toBe(true);
    store.accept([
      signed(agent, {
        kind: 7,
        content: "+",
        tags: [
          ["h", "a"],
          ["e", root.id],
        ],
      }),
    ]);
    expect(retained()).toBe(before);
    store.accept([
      signed(viewer, {
        kind: 40003,
        content: "edited",
        tags: [
          ["h", "a"],
          ["e", root.id],
        ],
      }),
    ]);
    expect(retained()[0]).toMatchObject({
      excerpt: "edited",
      edited: true,
      createdAt: 1,
    });
    store.accept([
      signed(viewer, {
        kind: 5,
        content: "",
        tags: [
          ["h", "a"],
          ["e", root.id],
        ],
      }),
    ]);
    expect(retained()).toEqual([]);
    store.dispose();
  });
  it("retains bounded raw title context and reference tags without changing the ordinary excerpt or eligibility", () => {
    const { store, retained, read, directory } = setup();
    const content = `    @Blossom\n${"x".repeat(200)}`;
    const root = message(viewer, "a", content, 1, [
      ["mention", agent.pubkey],
      ["mention", "invalid"],
    ]);
    store.accept([root]);
    expect(retained()[0]).toMatchObject({
      excerpt: content.slice(0, 160).trim().replace(/\s+/g, " "),
      titleSource: content.slice(0, 161),
      mentions: [],
      mentionReferences: [agent.pubkey],
    });
    expect(root.content).toBe(content);
    expect(read).not.toHaveBeenCalled();
    expect(directory.ensure).not.toHaveBeenCalled();
    store.dispose();
  });
  it("retains initial accepted locals without allocating any window, rejects their pending edits", () => {
    const root = message(viewer, "a", "accepted without window", 1);
    const operations: OutgoingEvent[] = [
      { event: root, delivery: "accepted" },
      {
        event: signed(viewer, {
          kind: 40003,
          content: "not accepted",
          tags: [
            ["h", "a"],
            ["e", root.id],
          ],
        }),
        delivery: "unknown",
      },
    ];
    const { store, retained, read } = setup({
      local: { snapshot: () => operations, subscribe: () => () => {} },
    });
    expect(store.retainedChannels()).toEqual([]);
    expect(retained()).toMatchObject([
      { id: root.id, excerpt: "accepted without window", edited: false },
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(store.retainedChannels()).toEqual([]);
    store.dispose();
  });
  it("invalidates silent traffic eviction and row shrink, without passive history pins", async () => {
    const { store, retained } = setup();
    const listener = vi.fn();
    store.queries.subscribeRetained?.(listener);
    store.accept([message(viewer, "a", "old", 1)]);
    expect(retained()).toHaveLength(1);
    // Exercise the real 64-tail capacity; no configurable test-only parallel cache.
    for (let i = 0; i < 64; i++)
      store.accept([message(viewer, `traffic${i}`, "root", i + 2)]);
    await flush();
    expect(retained()).toHaveLength(64);
    expect(retained().some((row) => row.channelId === "a")).toBe(false);
    expect(store.retainedChannels()).toEqual([]);
    store.accept(
      Array.from({ length: 257 }, (_, i) =>
        message(viewer, "a", `${i}`, i + 100),
      ),
    );
    expect(retained().filter((row) => row.channelId === "a")).toHaveLength(256);
    expect(retained().some((row) => row.excerpt === "0")).toBe(false);
    expect(listener).toHaveBeenCalled();
    store.dispose();
  });
  it("observes an unmounted hydrated head without a new query, then drops it on clear", async () => {
    const root = message(viewer, "a", "disk root", 1);
    const persistence = {
      read: vi.fn(async () => [
        {
          channelId: "a",
          savedAt: Date.now(),
          events: [
            root,
            bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
          ],
          profiles: [],
        },
      ]),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      retain: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const { store, retained, read } = setup({ prepared: true, persistence });
    const listener = vi.fn();
    store.queries.subscribeRetained?.(listener);
    expect(retained()).toEqual([]);
    await vi.waitFor(() =>
      expect(retained().map((row) => row.id)).toEqual([root.id]),
    );
    expect(listener).toHaveBeenCalled();
    expect(store.retainedChannels()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await store.clearCache();
    expect(retained()).toEqual([]);
    store.dispose();
  });
  it("does not touch LRU recency; history window eviction removes only its retained source", async () => {
    const { store, retained, read } = setup({ maxWindows: 1 });
    const a = message(viewer, "a", "A", 1),
      b = message(viewer, "b", "B", 2);
    read.mockResolvedValue([
      a,
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    store.queries.ensure("a");
    await flush();
    expect(retained().map((row) => row.id)).toEqual([a.id]);
    const stop = store.queries.subscribeRetained?.(() => retained());
    read.mockResolvedValue([
      b,
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    store.queries.ensure("b");
    await flush();
    expect(store.retainedChannels()).toEqual(["b"]);
    expect(retained().map((row) => row.id)).toEqual([b.id]);
    stop?.();
    store.dispose();
  });
});
