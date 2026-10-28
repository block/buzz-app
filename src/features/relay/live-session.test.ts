import { ReadError } from "./errors";
import { assert, expect, it, vi, afterEach } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "./testing";

it("clears retained repository homes on live recovery, cache clearing, and disposal", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const seed = async () => {
    const pending = owner.session.repositories.home(
      "repo-channel",
      new AbortController().signal,
    );
    wire.next().respond([]);
    await pending;
    expect(owner.session.repositories.peekHome("repo-channel")).toEqual({
      status: "none",
    });
  };
  try {
    await seed();
    live.state({ status: "connected", routes: [] });
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
    await owner.clearCache();
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
  } finally {
    owner.dispose();
  }
  expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
});

it("establishing a large roster reads only retained windows, not every channel head", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    const ids = Array.from({ length: 128 }, (_, i) => `channel-${i}`);
    const first = ids[0];
    assert.exists(first);
    live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure(first);
    const initial = wire.next();
    initial.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    live.state({ status: "connected", routes: [] });
    for (const id of ids) live.established(id);
    await flush();
    const catchup = wire.next();
    expect(catchup.filters[0]?.["#h"]).toEqual([ids[0]]);
    catchup.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "verified"),
    ).toHaveLength(1);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "deferred"),
    ).toHaveLength(127);
  } finally {
    owner.dispose();
  }
});

it("a skipped warm head cannot hide the stream gap behind its freshness lease", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true },
  );
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    owner.session.channels.prepare?.("a");
    const warm = wire.next();
    warm.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.retainedChannels()).toEqual([]);
    expect(owner.diagnostics().heads.entries).toBe(1);
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(owner.session.live.snapshot().heads[0]?.state).toBe("deferred");
    // Same wall-clock: freshness lease has not expired, but post-gap read is still required.
    owner.session.channels.ensure("a");
    await flush();
    const demand = wire.next();
    expect(demand.filters[0]?.["#h"]).toEqual(["a"]);
    demand.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.session.channels.window("a").freshness).toBe("verified");
    expect(
      owner.session.live.snapshot().heads.find((h) => h.channelId === "a")
        ?.state,
    ).toBe("verified");
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.channels.window("a").freshness).toBe("cached");
  } finally {
    owner.dispose();
  }
});

afterEach(() => vi.useRealTimers());
it("post-subscribe demand supersedes a pre-stream head and prioritizes the current retained reader", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const priority = vi.fn();
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize: priority, retry() {}, dispose() {} };
    },
  });
  try {
    live.receive(["a", "z"].map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure("a");
    const oldA = wire.next();
    oldA.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    owner.session.channels.ensure("z");
    const oldZ = wire.next();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("z");
    await flush();
    const current = wire.next();
    expect(current.filters[0]?.["#h"]).toEqual(["z"]);
    expect(oldZ.signal?.aborted).toBe(true);
    expect(priority.mock.lastCall?.[0][0]).toBe("z");
    current.respond([
      bounds(relay, "z", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const other = wire.next();
    expect(other.filters[0]?.["#h"]).toEqual(["a"]);
    other.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    owner.dispose();
  }
});
it("long API pause keeps lightweight catch-up obligations; retry does not drain or bypass cooldown", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    live.receive(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey])));
    for (const id of ["a", "b"]) {
      owner.session.channels.ensure(id);
      wire
        .next()
        .respond([
          bounds(relay, id, "head", { has_more: false, next_cursor: null }),
        ]);
      await flush();
    }
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("b");
    await flush();
    wire
      .next()
      .fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "error"),
    ).toBe(true);
    owner.session.live.retry();
    owner.session.channels.ensure("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValue(performance.now() + 61000);
    owner.session.live.retry();
    await flush();
    const retry = wire.next();
    retry.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const second = wire.next();
    second.respond([
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    clock.mockRestore();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
    owner.dispose();
  }
});

it.each([1, 2, 130])(
  "catch-up preserves unread evidence for a %s-channel roster",
  async (count) => {
    const relay = keypair(),
      viewer = keypair(),
      peer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      const ids = Array.from(
        { length: count },
        (_, i) => `room-${i.toString().padStart(3, "0")}`,
      );
      const first = ids[0];
      assert.exists(first);
      live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
      owner.session.channels.ensure(first);
      const oldHead = wire.next();
      const repair = owner.session.unread.ensure();
      await flush();
      const evidence = wire.next();
      expect(evidence.filters[0]?.["#h"]).toEqual(ids.slice(0, 128));
      // Force the production race: both the old head and unread batch are still
      // in flight when the live route establishes. Only the old head is obsolete.
      live.state({ status: "connected", routes: [] });
      live.established(first);
      await flush();
      const head = wire.next();
      expect(head.filters[0]).toMatchObject({ "#h": [first], top_level: true });
      expect(oldHead.signal?.aborted).toBe(true);
      expect(evidence.signal?.aborted).toBe(false);
      head.respond([
        bounds(relay, first, "head", { has_more: false, next_cursor: null }),
      ]);
      for (let offset = 0; offset < ids.length; offset += 128) {
        const batch = offset === 0 ? evidence : wire.next();
        const batchIds = ids.slice(offset, offset + 128);
        expect(batch.filters[0]?.["#h"]).toEqual(batchIds);
        batch.respond(
          batchIds.map((id) =>
            message(peer, id, "unread evidence", 1700000900),
          ),
        );
        await flush();
      }
      await repair;
      expect(wire.pending).toHaveLength(0);
      for (const channelId of ids) {
        const snapshot = owner.session.unread.snapshot({
          kind: "channel",
          channelId,
        });
        expect(snapshot).toMatchObject({
          observedCount: 1,
          freshness: "observed",
        });
        expect(snapshot.error).toBeUndefined();
      }
      // Evidence repair must not populate timeline windows or undo catch-up.
      expect(owner.session.channels.window(first).rows).toEqual([]);
      expect(
        owner.session.live.snapshot().heads.find((h) => h.channelId === first)
          ?.state,
      ).toBe("verified");
    } finally {
      owner.dispose();
    }
  },
);

function reconnectHarness() {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true },
  );
  const window = () => owner.session.channels.window("c");
  const rows = () => window().rows.map((row) => row.id);
  /** Outstanding channel window reads; merged rows also queue profile reads. */
  const reads = () =>
    wire.pending.filter((entry) => entry.filters[0]?.top_level === true);
  /** The one outstanding window read, after answering profile reads empty. */
  const read = () => {
    for (const entry of wire.pending.splice(0)) {
      if (entry.filters[0]?.kinds?.includes(0)) entry.respond([]);
      else wire.pending.push(entry);
    }
    expect(wire.pending.map((entry) => entry.filters)).toMatchObject([
      [{ "#h": ["c"], top_level: true }],
    ]);
    return wire.next();
  };
  const page = (
    suffix: string,
    events: readonly ReturnType<typeof message>[],
    next: ReturnType<typeof message> | null,
  ) => [
    ...events,
    bounds(relay, "c", suffix, {
      has_more: next !== null,
      next_cursor: next ? { created_at: next.created_at, id: next.id } : null,
    }),
  ];
  /** Open channel c with `seen` loaded and more history behind it, then reconnect. */
  const reconnect = async (seen: ReturnType<typeof message>) => {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "c", [viewer.pubkey]),
        metadata(relay, "c", "C"),
      ]);
    await flush();
    owner.session.channels.ensure("c");
    await flush();
    read().respond(page("head", [seen], seen));
    await flush();
    expect(rows()).toEqual([seen.id]);
    live.state({ status: "connected", routes: [] });
    live.established("c");
    await flush();
  };
  const cursor = (event: ReturnType<typeof message>) =>
    `${event.created_at}:${event.id}`;
  return {
    owner,
    alice,
    wire,
    window,
    rows,
    reads,
    read,
    page,
    reconnect,
    cursor,
  };
}

it("a reconnect catch-up head newer than every loaded row pages back until it reaches one", async () => {
  // Live replay covers minutes. The head alone would leave the loaded rows on
  // screen with a silent gap before it; each page merges as it lands.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      old = message(h.alice, "c", "old", 5);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [missed], missed));
    await flush();
    expect(h.rows()).toEqual([seen.id, missed.id]);
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: 30,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      error: undefined,
    });
    expect(h.reads()).toHaveLength(0);
    // Reads older than any loaded page still wait for paging to reach them.
    const read = h.owner.session.read([{ ids: [old.id], limit: 1 }]);
    const entry = h.wire.pending.find((entry) => entry.filters[0]?.ids);
    assert(entry);
    entry.respond([old]);
    await read;
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
  } finally {
    h.owner.dispose();
  }
});

it("a reconnect catch-up that never reaches a loaded row drops it and continues from its last page", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10);
    // Newest first: the head returns the first, then one row per page.
    const missed = [6, 5, 4, 3, 2, 1].map((n) =>
      message(h.alice, "c", `missed ${n}`, 10 + n * 10),
    );
    await h.reconnect(seen);
    let previous: (typeof missed)[number] | undefined;
    for (const row of missed) {
      const read = h.read();
      if (previous)
        expect(read.filters[0]).toMatchObject({
          until: previous.created_at,
          before_id: previous.id,
        });
      read.respond(h.page(previous ? h.cursor(previous) : "head", [row], row));
      await flush();
      previous = row;
    }
    // Five pages past the head never reached `seen`: it goes rather than
    // sitting below a gap, and older history continues from the last page.
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual(missed.map((row) => row.id).reverse());
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      historyLimited: false,
      error: undefined,
    });
    h.owner.session.channels.loadOlder("c");
    expect(h.read().filters[0]).toMatchObject({
      until: previous?.created_at,
      before_id: previous?.id,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a failed catch-up page keeps the pages already merged and reports the window cached", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [missed], missed));
    await flush();
    h.read().respond(h.page(h.cursor(missed), [between], between));
    await flush();
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
    h.read().fail(new Error("offline"));
    await flush();
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "cached",
      error: "offline",
    });
  } finally {
    h.owner.dispose();
  }
});
