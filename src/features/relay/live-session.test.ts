import { ReadError } from "./errors";
import { assert, expect, it, vi, afterEach } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  metadata,
  roster,
  scriptedTransport,
} from "./testing";

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
