import { assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
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
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish,
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, dispose() {}, retry() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  async function initial() {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "alpha", [viewer.pubkey]),
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "alpha", "Alpha"),
        metadata(relay, "beta", "Beta"),
      ]);
    await flush();
    live.state({ status: "connected", routes: [] });
  }
  const ownReads = () =>
    wire.pending.filter(({ filters }) =>
      filters.some(
        (filter) =>
          filter.authors?.includes(viewer.pubkey) &&
          filter.kinds?.includes(9) &&
          !filter["#h"],
      ),
    );
  const ownRead = () => ownReads()[0];
  return {
    owner,
    wire,
    viewer,
    peer,
    publish,
    initial,
    ownRead,
    ownReads,
    live: () => live,
  };
}

it("reads the viewer's own messages once through the session and adds a live own send", async () => {
  const h = setup();
  try {
    await h.initial();
    const posts = h.owner.session.ownPosts;
    expect(posts.snapshot().status).toBe("idle");
    const reading = posts.ensure();
    await vi.waitFor(() => expect(h.ownRead()).toBeDefined());
    // The one read is the viewer's own recent messages, not a per-channel read.
    expect(h.ownRead()?.filters).toHaveLength(1);
    expect(h.ownRead()?.filters[0]).toMatchObject({
      authors: [h.viewer.pubkey],
      limit: 500,
    });
    h.ownRead()?.respond([
      message(h.viewer, "alpha", "mine", 1_700_000_100),
      message(h.peer, "beta", "theirs", 1_700_000_101),
    ]);
    await reading;
    expect(posts.snapshot()).toEqual({
      status: "ready",
      channels: new Set(["alpha"]),
    });
    // The viewer's own send, accepted by the relay, joins at once.
    const listener = vi.fn();
    posts.subscribe(listener);
    h.owner.session.outbox?.send({
      kind: 9,
      content: "hello",
      tags: [["h", "beta"]],
    });
    await vi.waitFor(() =>
      expect(posts.snapshot().channels).toEqual(new Set(["alpha", "beta"])),
    );
    expect(listener).toHaveBeenCalled();
    assert.exists(h.publish.mock.calls[0]?.[0]);
    // Asking again after a settled read costs nothing.
    await posts.ensure();
    expect(h.ownReads()).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("counts a post from another device when its event arrives live", async () => {
  const h = setup();
  try {
    await h.initial();
    const posts = h.owner.session.ownPosts;
    const reading = posts.ensure();
    await vi.waitFor(() => expect(h.ownRead()).toBeDefined());
    h.ownRead()?.respond([]);
    await reading;
    expect(posts.snapshot().channels.size).toBe(0);
    const echoed = message(h.viewer, "alpha", "from my phone", 1_700_000_200);
    h.live().receive([echoed], { phase: "live", channelId: "alpha" });
    await vi.waitFor(() =>
      expect(posts.snapshot().channels).toEqual(new Set(["alpha"])),
    );
  } finally {
    h.owner.dispose();
  }
});
