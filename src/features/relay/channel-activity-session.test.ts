import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { ReadError } from "./errors";
import {
  flush as realFlush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";
import type { SidebarSortMode } from "./sidebar-sort";

afterEach(() => {
  vi.useRealTimers();
});
/** Lets pending work run, on whichever clock the test uses. */
const flush = () =>
  vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : realFlush();
/** Every roster head read starts within 500 ms (its jitter); tests that read
 * heads hold the clock so they decide when. */
const clocked = () =>
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
const headsStart = () => vi.advanceTimersByTimeAsync(500);
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const pending: {
    ids: readonly string[];
    signal: AbortSignal;
    topLevel: boolean;
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const activity = vi.fn(
    (ids: readonly string[], signal: AbortSignal, topLevel?: boolean) =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        pending.push({ ids, signal, topLevel: !!topLevel, resolve, reject }),
      ),
  );
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const sort: Record<string, SidebarSortMode> = {};
  const filters: Record<string, "active" | "unreads"> = {};
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish,
      },
      channelActivity: activity,
      decodeSidebarPreferences: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
        sort: {},
      }),
      writeSidebarSort: async (group, mode) => {
        if (mode === "alpha") delete sort[group];
        else sort[group] = mode;
        return { ...sort };
      },
      writeSidebarFilter: async (group, mode) => {
        if (mode === "all") delete filters[group];
        else filters[group] = mode;
        return { filters: { ...filters }, activeWindowSeconds: {} };
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, dispose() {}, retry() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  const channels = owner.session.channels;
  const preferences = owner.session.sidebarPreferences;
  async function initial(extra: readonly string[] = []) {
    channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "alpha", [viewer.pubkey]),
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "alpha", "Alpha"),
        metadata(relay, "beta", "Beta"),
        ...extra.flatMap((id) => [
          roster(relay, id, [viewer.pubkey]),
          metadata(relay, id, id),
        ]),
      ]);
    await flush();
    const reading = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await reading;
    live.state({ status: "connected", routes: [] });
  }
  return {
    owner,
    channels,
    preferences,
    pending,
    activity,
    publish,
    wire,
    viewer,
    relay,
    peer,
    live: () => live,
    initial,
  };
}
it("reads every roster channel's head once, whatever the sidebar sorts or filters by", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    // Lists are loading from the start: an empty answer proves nothing yet.
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(h.activity).not.toHaveBeenCalled();
    await headsStart();
    expect(h.activity).toHaveBeenCalledOnce();
    const reading = take(h.pending);
    expect(reading.ids).toEqual(["alpha", "beta"]);
    expect(reading.topLevel).toBe(false);
    reading.resolve([message(h.peer, "beta", "recent activity", 100)]);
    await flush();
    const first = h.channels.list();
    expect(first.activityStatus).toBe("ready");
    expect(first.channels.find((c) => c.id === "beta")?.lastActivityAt).toBe(
      100,
    );
    expect(first.channels.find((c) => c.id === "alpha")).toMatchObject({
      activityKnown: true,
    });
    expect(h.channels.list()).toBe(first);
    expect(h.owner.session.channelHeads.settled("alpha")).toBe(true);
    // No sort or filter asks again.
    await h.preferences.setSort("channels", "recent", []);
    await h.preferences.setFilter("channels", "active", []);
    await h.preferences.setSort("channels", "alpha", []);
    await h.preferences.setFilter("channels", "all", []);
    await headsStart();
    expect(h.activity).toHaveBeenCalledOnce();
  } finally {
    h.owner.dispose();
  }
});
it("projects verified live activity monotonically", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    await headsStart();
    take(h.pending).resolve([message(h.peer, "alpha", "history", 50)]);
    await flush();
    h.live().receive([message(h.peer, "alpha", "new", 90)]);
    h.live().receive([
      message(h.peer, "alpha", "older", 70),
      signed(h.peer, {
        kind: 39000,
        created_at: 200,
        tags: [["d", "beta"]],
        content: "metadata is not activity",
      }),
    ]);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(90);
    expect(
      h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
    ).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});
it("a channel whose newest event is a thread reply gets its top-level head in a second pass", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    await headsStart();
    const top = message(h.peer, "alpha", "top-level", 40);
    const reply = message(h.peer, "alpha", "reply", 60, [
      ["e", top.id, "", "root"],
      ["e", top.id, "", "reply"],
    ]);
    take(h.pending).resolve([reply, message(h.peer, "beta", "plain", 50)]);
    await flush();
    const heads = h.owner.session.channelHeads;
    expect(heads.settled("beta")).toBe(true);
    expect(heads.latest("beta")?.content).toBe("plain");
    expect(heads.settled("alpha")).toBe(false);
    expect(heads.status()).toBe("loading");
    const second = take(h.pending);
    expect(second).toMatchObject({ ids: ["alpha"], topLevel: true });
    second.resolve([top]);
    await flush();
    expect(heads.settled("alpha")).toBe(true);
    expect(heads.status()).toBe("ready");
    // The top-level head entered the session's own projections.
    expect(heads.latest("alpha")?.id).toBe(top.id);
    expect(
      h.owner.session.unread.snapshot({ kind: "channel", channelId: "alpha" })
        .latestTopLevel?.id,
    ).toBe(top.id);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(60);
    expect(h.activity).toHaveBeenCalledTimes(2);
  } finally {
    h.owner.dispose();
  }
});
it("a roster change reads only channels it adds, and a reconnect reads nothing", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    await headsStart();
    take(h.pending).resolve([message(h.peer, "alpha", "a", 50)]);
    await flush();
    h.live().receive([
      roster(h.relay, "gamma", [h.viewer.pubkey]),
      metadata(h.relay, "gamma", "Gamma"),
    ]);
    await headsStart();
    expect(h.activity).toHaveBeenCalledTimes(2);
    const added = take(h.pending);
    expect(added.ids).toEqual(["gamma"]);
    added.resolve([]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");

    h.live().state({ status: "retrying", routes: [] });
    h.live().state({ status: "connected", routes: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.activity).toHaveBeenCalledTimes(2);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);
  } finally {
    h.owner.dispose();
  }
});
// Own sends updated the row preview at once but moved it in Recent and Active
// only when the live socket echoed them.
it.each(["connected", "retrying"] as const)(
  "projects an own send the relay accepted while live is %s, before any echo",
  async (status) => {
    const h = setup();
    try {
      clocked();
      await h.initial();
      await headsStart();
      take(h.pending).resolve([message(h.peer, "alpha", "history", 50)]);
      await flush();
      h.live().state({ status, routes: [] });
      const beta = () =>
        h.channels.list().channels.find(({ id }) => id === "beta");
      expect(beta()?.lastActivityAt).toBeUndefined();
      h.owner.session.outbox?.send({
        kind: 9,
        content: "mine",
        tags: [["h", "beta"]],
      });
      await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
      await flush();
      const sent = h.publish.mock.calls[0]?.[0];
      assert.exists(sent);
      expect(beta()?.lastActivityAt).toBe(sent.created_at);
      if (status !== "connected") return;
      const summary = beta();
      h.live().receive([sent]);
      expect(beta()).toBe(summary);
    } finally {
      h.owner.dispose();
    }
  },
);
it.each([
  ["refused", new PublishRejected("blocked"), "failed"],
  ["left unanswered", new Error("timed out"), "unknown"],
] as const)(
  "does not project an own send the relay %s",
  async (_outcome, error, delivery) => {
    const h = setup();
    try {
      await h.initial();
      h.publish.mockRejectedValueOnce(error);
      h.owner.session.outbox?.send({
        kind: 9,
        content: "mine",
        tags: [["h", "beta"]],
      });
      await vi.waitFor(() =>
        expect(h.owner.session.outbox?.snapshot()[0]?.delivery).toBe(delivery),
      );
      await flush();
      expect(
        h.channels.list().channels.find(({ id }) => id === "beta")
          ?.lastActivityAt,
      ).toBeUndefined();
    } finally {
      h.owner.dispose();
    }
  },
);
// A send left `unknown` updated its preview once a read proved it landed, but
// its row stayed put without a live echo.
it("projects an unanswered own send once its read-back returns it", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().state({ status: "retrying", routes: [] });
    h.publish.mockRejectedValueOnce(new Error("timed out"));
    h.owner.session.outbox?.send({
      kind: 9,
      content: "mine",
      tags: [["h", "beta"]],
    });
    await vi.waitFor(() =>
      expect(h.owner.session.outbox?.snapshot()[0]?.delivery).toBe("unknown"),
    );
    const sent = h.publish.mock.calls[0]?.[0];
    assert.exists(sent);
    const beta = () =>
      h.channels.list().channels.find(({ id }) => id === "beta");
    expect(beta()?.lastActivityAt).toBeUndefined();
    const readBack = await vi.waitFor(() => {
      const entry = h.wire.pending.find(({ filters }) =>
        filters.some((filter) => filter.ids?.includes(sent.id)),
      );
      assert.exists(entry);
      return entry;
    });
    readBack.respond([sent]);
    // The verified read completes delivery before confirm() sees its result.
    await vi.waitFor(() =>
      expect(h.owner.session.outbox?.snapshot()).toEqual([]),
    );
    await flush();
    expect(beta()?.lastActivityAt).toBe(sent.created_at);
  } finally {
    h.owner.dispose();
  }
});
it("keeps other channels' summaries when one channel's live activity advances", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "a1", 50)]);
    h.live().receive([message(h.peer, "beta", "b1", 60)]);
    const find = (id: string) =>
      h.channels.list().channels.find((channel) => channel.id === id);
    const alpha = find("alpha");
    const beta = find("beta");
    expect(beta?.lastActivityAt).toBe(60);
    h.live().receive([message(h.peer, "alpha", "a2", 90)]);
    expect(find("alpha")).not.toBe(alpha);
    expect(find("alpha")?.lastActivityAt).toBe(90);
    expect(find("beta")).toBe(beta);
  } finally {
    h.owner.dispose();
  }
});
it("retries a transient head failure quietly; session recovery rereads only unsettled channels", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "last good", 50)]);
    await headsStart();
    take(h.pending).reject(
      new ReadError("unavailable", "Relay read failed (502)"),
    );
    await flush();
    // No error while the quiet retry waits (at most the first 1 s delay).
    expect(h.channels.list().activityStatus).toBe("loading");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.activity).toHaveBeenCalledTimes(2);
    take(h.pending).resolve([message(h.peer, "beta", "recovered", 100)]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(
      h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
    ).toBe(100);

    // A denial cannot clear on a quiet retry: it is reported at once.
    h.live().receive([
      roster(h.relay, "gamma", [h.viewer.pubkey]),
      metadata(h.relay, "gamma", "Gamma"),
    ]);
    await headsStart();
    const denied = take(h.pending);
    expect(denied.ids).toEqual(["gamma"]);
    denied.reject(new ReadError("denied", "Relay read failed (403)"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    expect(h.owner.session.recovery?.snapshot().recovering).toBe(true);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);
    // Recovery's first retry (1 s), then the head read's start jitter: it
    // reads only what is still unsettled.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.pending).toHaveLength(0);
    await headsStart();
    expect(h.pending).toHaveLength(1);
    const retried = take(h.pending);
    expect(retried.ids).toEqual(["gamma"]);
    retried.resolve([]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(h.activity).toHaveBeenCalledTimes(4);
  } finally {
    h.owner.dispose();
  }
});
it("projects heads read before a later batch failed and leaves only unread channels unknown", async () => {
  clocked();
  const h = setup();
  try {
    const rooms = Array.from({ length: 127 }, (_, i) => `room-${1000 + i}`);
    await h.initial(rooms);
    await headsStart();
    const find = (id: string) =>
      h.channels.list().channels.find((c) => c.id === id);
    const first = take(h.pending);
    expect(first.ids).toEqual(["alpha", "beta", ...rooms.slice(0, 126)]);
    first.resolve([message(h.peer, "beta", "landed", 90)]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(find("beta")?.lastActivityAt).toBe(90);
    const second = take(h.pending);
    expect(second.ids).toEqual(rooms.slice(126));
    second.reject(new Error("offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    expect(find("beta")?.lastActivityAt).toBe(90);
    expect(find("alpha")).toMatchObject({ activityKnown: true });
    expect(find(rooms[126] ?? "")?.activityKnown).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});
// Clearing every value on one channel's access loss flashed Recent sections to
// A–Z until the next read finished.
it("losing one channel keeps the others' activity and reads nothing more", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    await headsStart();
    take(h.pending).resolve([
      message(h.peer, "alpha", "a", 50),
      message(h.peer, "beta", "b", 60),
    ]);
    await flush();
    h.live().receive([
      roster(h.relay, "alpha", [], Math.floor(Date.now() / 1000) + 1),
    ]);
    const find = (id: string) =>
      h.channels.list().channels.find((channel) => channel.id === id);
    expect(find("beta")?.lastActivityAt).toBe(60);
    expect(find("alpha")?.lastActivityAt).toBeUndefined();
    await headsStart();
    expect(h.activity).toHaveBeenCalledOnce();
  } finally {
    h.owner.dispose();
  }
});
it.each(["clear", "dispose", "revoke"] as const)(
  "%s fences head reads and cannot leak late data into a new lifetime",
  async (action) => {
    clocked();
    const h = setup();
    try {
      await h.initial();
      await headsStart();
      const request = take(h.pending);
      if (action === "clear") await h.owner.clearCache();
      if (action === "dispose") h.owner.dispose();
      if (action === "revoke")
        h.live().receive([
          roster(h.relay, "alpha", [], Math.floor(Date.now() / 1000) + 1),
        ]);
      expect(request.signal.aborted).toBe(true);
      request.resolve([message(h.peer, "alpha", "retired", 100)]);
      await flush();
      expect(
        h.channels.list().channels.find((c) => c.id === "alpha")
          ?.lastActivityAt,
      ).toBeUndefined();
    } finally {
      h.owner.dispose();
    }
  },
);
it("a disconnect neither cancels the head read nor repeats it", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    await headsStart();
    const request = take(h.pending);
    h.live().state({ status: "retrying", routes: [] });
    expect(request.signal.aborted).toBe(false);
    request.resolve([message(h.peer, "alpha", "kept", 100)]);
    await flush();
    h.live().state({ status: "connected", routes: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(100);
    expect(h.activity).toHaveBeenCalledOnce();
  } finally {
    h.owner.dispose();
  }
});

function take<T>(pending: T[]): T {
  const next = pending.shift();
  assert.exists(next, "Expected a pending operation");
  return next;
}

it("projects authoritative empty activity", async () => {
  clocked();
  const h = setup();
  try {
    await h.initial();
    await headsStart();
    take(h.pending).resolve([]);
    await flush();
    const quiet = () =>
      h.channels.list().channels.find(({ id }) => id === "beta");
    expect(quiet()).toMatchObject({ activityKnown: true });
    expect(quiet()?.lastActivityAt).toBeUndefined();
    expect(h.owner.session.channelHeads.settled("beta")).toBe(true);
    expect(h.owner.session.channelHeads.latest("beta")).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});
