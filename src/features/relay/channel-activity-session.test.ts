import { assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const pending: {
    ids: readonly string[];
    signal: AbortSignal;
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const activity = vi.fn(
    (ids: readonly string[], signal: AbortSignal) =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        pending.push({ ids, signal, resolve, reject }),
      ),
  );
  const sort: Record<string, "recent"> = {};
  const owner = createRelaySession({
    ...wire.transport,
    channelActivity: activity,
    decodeSidebarPreferences: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      sort: {},
    }),
    writeSidebarSort: async (group, mode) => {
      if (mode === "recent") sort[group] = mode;
      else delete sort[group];
      return { ...sort };
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, dispose() {}, retry() {} };
    },
  });
  const channels = owner.session.channels;
  const preferences = owner.session.sidebarPreferences;
  async function initial() {
    channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "alpha", [viewer.pubkey]),
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "alpha", "Alpha"),
        metadata(relay, "beta", "Beta"),
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
    viewer,
    relay,
    peer,
    live: () => live,
    initial,
  };
}
it("reads no roster activity for A–Z, deduplicates Recent demand, and projects verified live activity monotonically", async () => {
  const h = setup();
  try {
    await h.initial();
    expect(h.activity).not.toHaveBeenCalled();
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledOnce();
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(h.pending[0]?.ids).toEqual(["alpha", "beta"]);
    take(h.pending).resolve([message(h.peer, "alpha", "history", 50)]);
    await flush();
    const first = h.channels.list();
    expect(first.activityStatus).toBe("ready");
    expect(first.channels.find((c) => c.id === "alpha")?.lastActivityAt).toBe(
      50,
    );
    expect(h.channels.list()).toBe(first);
    await h.preferences.setSort("dms", "recent", []);
    expect(h.activity).toHaveBeenCalledOnce();
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
it("cancels only after the last Recent section clears and refreshes unchanged rosters on re-entry", async () => {
  const h = setup();
  try {
    await h.initial();
    await h.preferences.setSort("channels", "recent", []);
    const retired = take(h.pending);
    await h.preferences.setSort("dms", "recent", []);
    await h.preferences.setSort("channels", "alpha", []);
    expect(retired.signal.aborted).toBe(false);
    expect(h.activity).toHaveBeenCalledOnce();
    await h.preferences.setSort("dms", "alpha", []);
    expect(retired.signal.aborted).toBe(true);
    expect(h.channels.list().activityStatus).toBe("idle");
    // Ignoring transport cancellation must not let late history win. Live
    // activity remains valid even while every section is A–Z.
    retired.resolve([message(h.peer, "alpha", "retired history", 200)]);
    h.live().receive([message(h.peer, "alpha", "live", 90)]);
    await flush();
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(90);
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledTimes(2);
    const resumed = take(h.pending);
    expect(resumed.ids).toEqual(["alpha", "beta"]);
    resumed.resolve([message(h.peer, "alpha", "fresh history", 120)]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(120);
    // Completed data stays useful, but a new demand lifetime still refreshes it.
    await h.preferences.setSort("channels", "alpha", []);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(120);
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledTimes(3);
    take(h.pending).resolve([]);
    await flush();
  } finally {
    h.owner.dispose();
  }
});
it.each(["clear", "dispose", "revoke", "disconnect"] as const)(
  "%s fences activity reads and cannot leak late data into a new lifetime",
  async (action) => {
    const h = setup();
    try {
      await h.initial();
      await h.preferences.setSort("channels", "recent", []);
      const request = take(h.pending);
      if (action === "clear") await h.owner.clearCache();
      if (action === "dispose") h.owner.dispose();
      if (action === "revoke")
        h.live().receive([
          roster(h.relay, "alpha", [], Math.floor(Date.now() / 1000) + 1),
        ]);
      if (action === "disconnect")
        h.live().state({ status: "retrying", routes: [] });
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

function take<T>(pending: T[]): T {
  const next = pending.shift();
  assert.exists(next, "Expected a pending operation");
  return next;
}
