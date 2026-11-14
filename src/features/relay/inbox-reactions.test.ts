import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
  type Key,
} from "./testing";
import { matchesEvent } from "./projection";
import type { RelayEvent, ReadFilter } from "./events";
import type { LiveCallbacks } from "./live";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup({ relayIndexesTargetAuthor = false } = {}) {
  const viewer = keypair(),
    alice = keypair(),
    bob = keypair(),
    relay = keypair();
  let live!: LiveCallbacks;
  const target = message(viewer, "room", "My older message", 10);
  const events: RelayEvent[] = [target];
  const indexed = (event: RelayEvent): RelayEvent => {
    const reacted =
      relayIndexesTargetAuthor && event.kind === 7
        ? events.find((candidate) =>
            event.tags.some(
              ([name, id]) => name === "e" && id === candidate.id,
            ),
          )
        : undefined;
    return reacted
      ? { ...event, tags: [...event.tags, ["p", reacted.pubkey]] }
      : event;
  };
  let gate: Promise<void> | undefined;
  let fail = false;
  let overlayGate: Promise<void> | undefined;
  let overlayStarted: (() => void) | undefined;
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (filters.some((filter) => filter.ids?.includes(target.id))) await gate;
    if (fail && filters.some((filter) => filter["#e"]))
      throw new Error("updates offline");
    const result = filters.flatMap((filter) =>
      events
        .filter((event) => matchesEvent(indexed(event), filter))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit),
    );
    if (filters.some((filter) => filter["#e"]) && overlayGate) {
      const held = overlayGate;
      overlayGate = undefined;
      overlayStarted?.();
      await held;
    }
    return result;
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  live.receive([
    roster(relay, "room", [viewer.pubkey, alice.pubkey, bob.pubkey], 1),
    metadata(relay, "room", "Room", 1),
  ]);
  const feed = owner.session.inboxFeed.reactions;
  const react = (
    author: Key = alice,
    at = 20,
    targetId = target.id,
    tags: string[][] = [],
  ) =>
    signed(author, {
      kind: 7,
      content: "❤️",
      created_at: at,
      tags: [["e", targetId], ["p", viewer.pubkey], ...tags],
    });
  return {
    viewer,
    alice,
    bob,
    relay,
    target,
    events,
    feed,
    query,
    owner,
    react,
    untagged: (author: Key = alice, at = 20, targetId = target.id) =>
      signed(author, {
        kind: 7,
        content: "❤️",
        created_at: at,
        tags: [["e", targetId]],
      }),
    emit(batch: RelayEvent[], phase: "live" | "replay" = "live") {
      events.push(...batch);
      live.receive(batch, { phase, channelId: "room" });
    },
    deliver(batch: RelayEvent[], path: "live" | "history") {
      if (path === "live") this.emit(batch);
      else events.push(...batch);
    },
    archive(value: boolean) {
      const event = metadata(relay, "room", "Room", value ? 100 : 101);
      live.receive([
        signed(relay, {
          ...event,
          tags: [...event.tags, ["archived", String(value)]],
        }),
      ]);
    },
    holdOverlay() {
      let release!: () => void;
      overlayGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        overlayStarted = resolve;
      });
      return { release, started };
    },
    revoke() {
      live.receive([roster(relay, "room", [alice.pubkey], 100)]);
    },
    fail(value: boolean) {
      fail = value;
    },
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

it("recovers addressed reactions on an unloaded old message without changing unread or emitting a live arrival", async () => {
  const h = setup();
  const arrival = vi.fn();
  h.feed.subscribeArrival(arrival);
  h.events.push(h.react(), h.react(h.bob, 21));
  const before = h.owner.session.unread.inbox();
  await h.feed.ensure();
  expect(h.feed.snapshot()).toMatchObject({
    status: "ready",
    items: [
      {
        id: `reaction:${h.target.id}`,
        createdAt: 21,
        message: { content: "My older message" },
      },
    ],
  });
  expect(h.feed.snapshot().items[0]?.events).toHaveLength(2);
  expect(h.owner.session.unread.inbox()).toBe(before);
  expect(arrival).not.toHaveBeenCalled();
});

it("hydrates a live target before one arrival, dedupes routes, and never pulses replay", async () => {
  const h = setup();
  const release = h.hold();
  const arrival = vi.fn();
  h.feed.subscribeArrival(arrival);
  const reaction = h.react();
  h.emit([reaction]);
  await vi.waitFor(() =>
    expect(
      h.query.mock.calls.some(([filters]) =>
        filters.some((filter) => filter.ids?.includes(h.target.id)),
      ),
    ).toBe(true),
  );
  expect(arrival).not.toHaveBeenCalled();
  expect(h.feed.snapshot().items).toEqual([]);
  release();
  await h.feed.ensure();
  expect(arrival).toHaveBeenCalledExactlyOnceWith(reaction);
  h.emit([reaction]);
  await h.feed.ensure();
  h.emit([h.react(h.bob, 30)], "replay");
  await h.feed.ensure();
  expect(arrival).toHaveBeenCalledTimes(1);
  expect(h.feed.snapshot().items[0]?.events).toHaveLength(2);
});

it("excludes self, missing, forged-owner and mismatched-channel reactions", async () => {
  const h = setup();
  const other = message(h.alice, "room", "Not mine", 12);
  h.events.push(
    other,
    h.react(h.viewer),
    h.react(h.alice, 22, "f".repeat(64)),
    h.react(h.alice, 23, other.id),
    h.react(h.alice, 24, h.target.id, [["h", "elsewhere"]]),
  );
  await h.feed.ensure();
  expect(h.feed.snapshot()).toMatchObject({ status: "ready", items: [] });
});

// History reads model a relay that indexes the reacted message's author for
// `#p`; live delivery comes from the channel subscription either way.
it.each(["live", "history"] as const)(
  "admits an untagged reaction on the viewer's message (%s)",
  async (path) => {
    const h = setup({ relayIndexesTargetAuthor: path === "history" });
    const reaction = h.untagged();
    h.deliver([reaction], path);
    await h.feed.ensure();
    expect(h.feed.snapshot()).toMatchObject({
      status: "ready",
      items: [{ id: `reaction:${h.target.id}`, events: [reaction] }],
    });
  },
);

it.each(["live", "history"] as const)(
  "drops an untagged reaction on someone else's message (%s)",
  async (path) => {
    const h = setup({ relayIndexesTargetAuthor: path === "history" });
    const other = message(h.bob, "room", "Not mine", 12);
    h.events.push(other);
    const owned = h.untagged(h.alice, 20);
    h.deliver([owned, h.untagged(h.alice, 21, other.id)], path);
    await h.feed.ensure();
    expect(
      h.feed.snapshot().items.map((item) => item.events.map(({ id }) => id)),
    ).toEqual([[owned.id]]);
  },
);

it("skips the target fetch for a live reaction tagged only to another pubkey", async () => {
  const h = setup();
  const other = message(h.bob, "room", "Not mine", 12);
  h.events.push(other);
  const owned = h.react(h.alice, 20);
  h.emit([
    owned,
    signed(h.alice, {
      kind: 7,
      content: "❤️",
      created_at: 21,
      tags: [
        ["e", other.id],
        ["p", h.bob.pubkey],
      ],
    }),
  ]);
  await h.feed.ensure();
  expect(
    h.feed.snapshot().items.map((item) => item.events.map(({ id }) => id)),
  ).toEqual([[owned.id]]);
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter.ids?.includes(other.id)),
    ),
  ).toBe(false);
});

it("checks a foreign untagged reaction once and keeps the viewer's rows past 100 newer ones", async () => {
  const h = setup();
  const other = message(h.bob, "room", "Not mine", 12);
  h.events.push(other);
  const owned = h.react(h.alice, 20);
  h.events.push(owned);
  await h.feed.ensure();
  const fetchesOther = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.ids?.includes(other.id)),
    ).length;
  h.emit([h.untagged(h.alice, 30, other.id)]);
  await h.feed.ensure();
  expect(fetchesOther()).toBe(1);
  // Once the target is verified as someone else's, more reactions to it cost
  // no relay reads at all.
  const reads = h.query.mock.calls.length;
  for (let at = 31; at <= 130; at++) {
    h.emit([h.untagged(h.alice, at, other.id)]);
    await h.feed.ensure();
  }
  expect(h.query.mock.calls.length).toBe(reads);
  await h.feed.refresh();
  expect(fetchesOther()).toBe(1);
  expect(
    h.feed.snapshot().items.map((item) => item.events.map(({ id }) => id)),
  ).toEqual([[owned.id]]);
});

it("keeps checking a target it could not read, so access can return", async () => {
  const h = setup();
  const missing = "d".repeat(64);
  await h.feed.ensure();
  const fetchesMissing = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.ids?.includes(missing)),
    ).length;
  h.emit([h.untagged(h.alice, 30, missing)]);
  await h.feed.ensure();
  h.emit([h.untagged(h.alice, 31, missing)]);
  await h.feed.ensure();
  expect(fetchesMissing()).toBe(2);
});

it("reads no target for reactions to other people's messages it already received", async () => {
  const h = setup();
  await h.feed.ensure();
  const others = Array.from({ length: 50 }, (_, index) =>
    message(h.bob, "room", `Bob ${index}`, 30 + index),
  );
  h.emit(others);
  const reads = h.query.mock.calls.length;
  for (const [index, other] of others.entries()) {
    h.emit([h.untagged(h.alice, 100 + index, other.id)]);
    await h.feed.ensure();
  }
  expect(h.query.mock.calls.length).toBe(reads);
});

it("keeps the viewer's reactions in a channel archived during a refresh", async () => {
  const h = setup();
  const mine = Array.from({ length: 60 }, (_, index) =>
    message(h.viewer, "room", `Mine ${index}`, 11 + index),
  );
  h.events.push(...mine);
  for (const [index, own] of mine.entries())
    h.emit([h.react(h.alice, 100 + index, own.id)]);
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toHaveLength(60);
  h.archive(true);
  await h.feed.refresh();
  h.archive(false);
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toHaveLength(60);
});

it.each(["live", "history"] as const)(
  "drops a forged viewer p tag on someone else's message (%s)",
  async (path) => {
    const h = setup({ relayIndexesTargetAuthor: path === "history" });
    const other = message(h.bob, "room", "Not mine", 12);
    h.events.push(other);
    const owned = h.react(h.alice, 20);
    h.deliver([owned, h.react(h.alice, 21, other.id)], path);
    await h.feed.ensure();
    expect(
      h.feed.snapshot().items.map((item) => item.events.map(({ id }) => id)),
    ).toEqual([[owned.id]]);
  },
);

it("settles deletion before reaction, duplicate removal and target edits/deletion", async () => {
  const h = setup();
  const first = h.react(),
    duplicate = h.react(h.alice, 21);
  const remove = (event: RelayEvent, author = h.alice) =>
    signed(author, {
      kind: 5,
      content: "",
      created_at: 40,
      tags: [["e", event.id]],
    });
  h.events.push(first, duplicate, remove(first));
  await h.feed.ensure();
  expect(h.feed.snapshot().items[0]?.events.map((event) => event.id)).toEqual([
    duplicate.id,
  ]);
  h.emit([remove(duplicate, h.bob)]);
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toHaveLength(1);
  const edit = signed(h.viewer, {
    kind: 40003,
    content: "Edited context",
    created_at: 50,
    tags: [
      ["h", "room"],
      ["e", h.target.id],
    ],
  });
  h.emit([edit]);
  await h.feed.ensure();
  expect(h.feed.snapshot().items[0]?.message.content).toBe("Edited context");
  h.emit([remove(edit, h.viewer)]);
  await h.feed.ensure();
  expect(h.feed.snapshot().items[0]?.message.content).toBe("My older message");
  h.emit([remove(h.target, h.viewer)]);
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toEqual([]);
  h.emit([duplicate], "replay");
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toEqual([]);
});

it("withholds failed settlement, retries, and purges revoked data and pending hydration", async () => {
  const h = setup();
  h.events.push(h.react());
  h.fail(true);
  await h.feed.ensure();
  expect(h.feed.snapshot()).toMatchObject({
    status: "error",
    items: [],
    error: "updates offline",
  });
  h.fail(false);
  await h.feed.refresh();
  expect(h.feed.snapshot().items).toHaveLength(1);
  const release = h.hold();
  const arrival = vi.fn();
  h.feed.subscribeArrival(arrival);
  h.emit([h.react(h.bob, 60)]);
  h.revoke();
  release();
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toEqual([]);
  expect(arrival).not.toHaveBeenCalled();
});

it("withholds previews when a deletion references an unloaded second target", async () => {
  const h = setup();
  h.events.push(h.react());
  await h.feed.ensure();
  const gate = h.holdOverlay();
  h.emit([
    signed(h.viewer, {
      kind: 5,
      content: "",
      created_at: 40,
      tags: [
        ["e", h.target.id],
        ["e", "f".repeat(64)],
      ],
    }),
  ]);
  try {
    await gate.started;
    expect(h.feed.snapshot().items).toEqual([]);
  } finally {
    gate.release();
  }
  await h.feed.ensure();
  expect(h.feed.snapshot()).toMatchObject({ status: "error", items: [] });
});

it.each([false, true])(
  "settles pending reaction removal before arrival (same batch: %s)",
  async (sameBatch) => {
    const h = setup();
    const reaction = h.react();
    const removal = signed(h.alice, {
      kind: 5,
      content: "",
      created_at: 40,
      tags: [["e", reaction.id]],
    });
    const arrival = vi.fn();
    h.feed.subscribeArrival(arrival);
    const gate = h.holdOverlay();
    h.emit(sameBatch ? [removal, reaction] : [reaction]);
    try {
      await gate.started;
      if (!sameBatch) h.emit([removal]);
      expect(h.feed.snapshot().items).toEqual([]);
      expect(arrival).not.toHaveBeenCalled();
    } finally {
      gate.release();
    }
    await h.feed.ensure();
    expect(h.feed.snapshot()).toMatchObject({ status: "ready", items: [] });
    expect(arrival).not.toHaveBeenCalled();
  },
);

it("restores archived channel reactions after unarchive without a live pulse", async () => {
  const h = setup();
  h.events.push(h.react());
  await h.feed.ensure();
  const arrival = vi.fn();
  h.feed.subscribeArrival(arrival);
  h.archive(true);
  expect(h.feed.snapshot().items).toEqual([]);
  const gate = h.holdOverlay();
  h.archive(false);
  try {
    await gate.started;
    expect(h.feed.snapshot().items).toEqual([]);
  } finally {
    gate.release();
  }
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toHaveLength(1);
  expect(arrival).not.toHaveBeenCalled();
});

it("does not let archived-room overlays poison another room's reactions", async () => {
  const h = setup();
  const second = message(h.viewer, "other", "Other message", 11);
  h.emit([
    roster(h.relay, "other", [h.viewer.pubkey, h.alice.pubkey], 1),
    metadata(h.relay, "other", "Other", 1),
  ]);
  const first = h.react();
  h.events.push(second, first, h.react(h.alice, 21, second.id));
  await h.feed.ensure();
  expect(h.feed.snapshot().items).toHaveLength(2);
  h.emit([
    signed(h.alice, {
      kind: 5,
      content: "",
      created_at: 40,
      tags: [["e", first.id]],
    }),
  ]);
  await h.feed.ensure();
  h.archive(true);
  await h.feed.refresh();
  expect(h.feed.snapshot()).toMatchObject({
    status: "ready",
    items: [{ channelId: "other" }],
  });
  await h.feed.refresh();
  expect(h.feed.snapshot()).toMatchObject({
    status: "ready",
    items: [{ channelId: "other" }],
  });
});
