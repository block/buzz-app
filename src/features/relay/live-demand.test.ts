import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { ReadError } from "./errors";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  signed,
  scriptedTransport,
} from "./testing";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize() {}, retry() {}, dispose() {} };
    },
  });
  const connected = () =>
    live.state({
      status: "connected",
      routes: [
        { id: "profiles", status: "live", replay: "unknown" },
        { id: "membership", status: "live", replay: "unknown" },
      ],
    });
  return {
    relay,
    viewer,
    wire,
    owner,
    get live() {
      return live;
    },
    connected,
  };
}
it("Retry live updates recovers roster catch-up refused after globals established", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const first = h.wire.next();
    expect(first.filters[0]?.kinds).toEqual([39002]);
    first.fail(
      new ReadError("unavailable", "Relay requests paused", 429, 60000),
    );
    await flush();
    expect(h.owner.session.channels.list()).toMatchObject({
      status: "error",
      channels: [],
    });
    expect(h.owner.session.live.snapshot().roster).toEqual({
      state: "error",
      error: "Relay requests paused",
    });
    h.owner.session.live.retry();
    h.owner.session.channels.refreshList?.();
    h.owner.session.channels.ensureList();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.channels.list().status).toBe("ready");
    expect(h.owner.session.live.snapshot().roster).toEqual({
      state: "verified",
    });
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});
it("positive roster control: diagnostic refresh recovers the same refused roster", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    h.wire
      .next()
      .fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.channels.refreshList?.();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.channels.list().status).toBe("ready");
  } finally {
    h.owner.dispose();
  }
});
it("current-channel post-subscribe read keeps a foreground slot when another background read is stalled", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    const background = h.owner.session
      .read([{ kinds: [0], authors: [h.viewer.pubkey], limit: 1 }], {
        priority: "background",
      })
      .catch(() => []);
    const stalled = h.wire.next();
    h.connected();
    h.live.established("a");
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    expect(h.wire.pending[0]?.filters[0]?.["#h"]).toEqual(["a"]);
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(h.owner.session.live.snapshot().heads[0]?.state).toBe("verified");
    stalled.respond([]);
    await background;
  } finally {
    h.owner.dispose();
  }
});
it("post-subscribe verification means the fetched gap message actually reaches the retained window", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    h.connected();
    h.live.established("a");
    await flush();
    const gap = message(h.viewer, "a", "arrived in gap", 1700000001);
    h.wire
      .next()
      .respond([
        gap,
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(h.owner.session.live.snapshot().heads[0]?.state).toBe("verified");
    expect(
      h.owner.session.channels.window("a").rows.map((row) => row.id),
    ).toContain(gap.id);
    for (const request of h.wire.pending.splice(0)) request.respond([]);
    await flush();
  } finally {
    h.owner.dispose();
  }
});
it("Refresh messages during known catch-up cooldown preserves the lightweight obligation", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    h.connected();
    h.live.established("a");
    await flush();
    h.wire
      .next()
      .fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    h.owner.session.channels.refresh?.("a");
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.channels.refresh?.("a");
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire
      .next()
      .respond([
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(h.owner.session.live.snapshot().heads[0]?.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});

it("coalesces hints during a busy roster without letting retry clicks create work", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const first = h.wire.next();
    h.owner.session.live.retry();
    h.owner.session.live.retry();
    first.respond([]);
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    h.owner.session.channels.refreshList?.();
    const second = h.wire.next();
    const hint = signed(h.relay, {
      kind: 44100,
      content: "",
      tags: [["p", h.viewer.pubkey]],
    });
    h.live.receive([hint]);
    h.live.receive([hint]);
    await flush();
    second.respond([]);
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("queued membership hints and reconnect cannot bypass a learned roster pause", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const first = h.wire.next();
    h.live.receive([
      signed(h.relay, {
        kind: 44100,
        content: "",
        tags: [["p", h.viewer.pubkey]],
      }),
    ]);
    await flush();
    first.fail(new ReadError("unavailable", "Paused", 429, 60000));
    await flush();
    h.live.state({ status: "retrying", routes: [] });
    h.connected();
    h.live.established();
    await flush();
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each(["unavailable", "denied"] as const)(
  "a %s metadata read retains roster authority and remains recoverable",
  async (kind) => {
    const h = setup();
    try {
      h.live.receive([roster(h.relay, "old", [h.viewer.pubkey])]);
      h.connected();
      h.live.established();
      await flush();
      h.wire.next().respond([roster(h.relay, "a", [h.viewer.pubkey])]);
      await flush();
      expect(h.owner.session.channels.list().channels.map((c) => c.id)).toEqual(
        ["a"],
      );
      const names = h.wire.next();
      expect(names.filters[0]?.kinds).toEqual([39000]);
      names.fail(
        new ReadError(
          kind,
          "Names unavailable",
          kind === "denied" ? 403 : 429,
          60000,
        ),
      );
      await flush();
      expect(h.owner.session.channels.list().channels.map((c) => c.id)).toEqual(
        ["a"],
      );
      expect(h.owner.session.live.snapshot().roster.state).toBe("error");
      h.owner.session.live.retry();
      await flush();
      expect(h.wire.pending).toHaveLength(0);
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
      h.owner.session.live.retry();
      await flush();
      h.wire
        .next()
        .respond([
          roster(h.relay, "a", [h.viewer.pubkey]),
          metadata(h.relay, "a", "A"),
        ]);
      await flush();
      expect(h.owner.session.channels.list().status).toBe("ready");
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  },
);

it("denied roster revokes retained access; ordinary retry only regrants with fresh authority", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "a", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    const secret = message(h.viewer, "a", "private", 1700000001);
    h.wire
      .next()
      .respond([
        secret,
        bounds(h.relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    for (const request of h.wire.pending.splice(0)) request.respond([]);
    await flush();
    h.connected();
    h.live.established();
    await flush();
    h.wire.next().fail(new ReadError("denied", "Membership denied", 403));
    await flush();
    expect(h.owner.session.channels.list().channels).toEqual([]);
    expect(h.owner.session.channels.window("a").rows).toEqual([]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("error");
    h.owner.session.live.retry();
    await flush();
    expect(h.owner.session.channels.window("a").rows).toEqual([]);
    h.wire
      .next()
      .respond([
        roster(h.relay, "a", [h.viewer.pubkey], 1700000002),
        metadata(h.relay, "a", "A"),
      ]);
    await flush();
    expect(h.owner.session.channels.list().status).toBe("ready");
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    expect(h.owner.session.channels.window("a").rows).toEqual([]);
  } finally {
    h.owner.dispose();
  }
});

it("an interrupted roster cannot satisfy a new connection's establishment", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const stale = h.wire.next();
    h.live.state({ status: "retrying", routes: [] });
    h.connected();
    h.live.established();
    await flush();
    expect(stale.signal?.aborted).toBe(true);
    stale.respond([roster(h.relay, "stale", [h.viewer.pubkey])]);
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    expect(h.owner.session.live.snapshot().roster.state).toBe("pending");
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.channels.list().channels).toEqual([]);
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});

it.each(["roster", "metadata"])(
  "disposal fences late %s completions and retry",
  async (stage) => {
    const h = setup();
    h.connected();
    h.live.established();
    await flush();
    let late = h.wire.next();
    if (stage === "metadata") {
      late.respond([roster(h.relay, "a", [h.viewer.pubkey])]);
      await flush();
      late = h.wire.next();
    }
    const changed = vi.fn();
    h.owner.session.live.subscribe(changed);
    h.owner.dispose();
    const snapshot = h.owner.session.live.snapshot();
    late.respond([]);
    await flush();
    h.owner.session.live.retry();
    await flush();
    expect(late.signal?.aborted).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(h.owner.session.live.snapshot()).toBe(snapshot);
    expect(h.wire.pending).toHaveLength(0);
  },
);

it("cache-clear interrupts a roster without a newer hint: deferred, not falsely verified, and retryable", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    const old = h.wire.next();
    await h.owner.clearCache();
    old.respond([roster(h.relay, "stale", [h.viewer.pubkey])]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("deferred");
    expect(h.owner.session.channels.list().channels).toEqual([]);
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});
it("a ready unchanged list still publishes roster pending before the refresh read", async () => {
  const h = setup();
  try {
    h.connected();
    h.live.established();
    await flush();
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    const changed = vi.fn();
    h.owner.session.live.subscribe(changed);
    const list = h.owner.session.channels.list();
    h.owner.session.channels.refreshList?.();
    expect(h.owner.session.channels.list()).toBe(list);
    expect(h.owner.session.live.snapshot().roster.state).toBe("pending");
    expect(changed).toHaveBeenCalled();
    h.wire.next().respond([]);
    await flush();
    expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});
it("disposing from the pending-roster notification blocks subsequent list notifications and dispatch", async () => {
  const h = setup();
  let disposedList:
    | ReturnType<typeof h.owner.session.channels.list>
    | undefined;
  const listChanged = vi.fn();
  h.owner.session.channels.subscribeList(listChanged);
  h.owner.session.live.subscribe(() => {
    if (h.owner.session.live.snapshot().roster.state === "pending") {
      h.owner.dispose();
      disposedList = h.owner.session.channels.list();
    }
  });
  h.owner.session.channels.ensureList();
  await flush();
  expect(disposedList).toBeDefined();
  expect(h.owner.session.channels.list()).toBe(disposedList);
  expect(listChanged).not.toHaveBeenCalled();
  expect(h.wire.pending).toHaveLength(0);
});
