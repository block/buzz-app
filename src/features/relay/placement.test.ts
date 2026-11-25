import { expect, it, vi } from "vitest";
import type { HeadPersistence, SavedHead } from "./persistence";
import { foldMessages } from "./fold";
import { eventVisibility } from "./event-access";
import { channelRowChannel } from "./membership";
import { eventChannel, inChannel, placeServed } from "./placement";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const viewer = keypair(),
  relay = keypair(),
  other = keypair();
const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const served = (channel: string) =>
  [{ "#h": [channel], kinds: [9], limit: 10, top_level: true }] as const;

it("places an event the relay served under another channel, leaving the event as signed", () => {
  const moved = message(viewer, source, "Moved", 20);
  const stay = message(viewer, destination, "Home", 21);
  placeServed(served(destination), [moved, stay]);
  expect(eventChannel(moved)).toBe(destination);
  expect(inChannel(moved, destination)).toBe(true);
  expect(inChannel(moved, source)).toBe(false);
  expect(channelRowChannel(moved)).toBe(destination);
  expect(moved.tags.find(([name]) => name === "h")?.[1]).toBe(source);
  expect(eventChannel(stay)).toBe(destination);
  expect(foldMessages(destination, relay.pubkey, [moved, stay])).toHaveLength(
    2,
  );
  expect(foldMessages(source, relay.pubkey, [moved])).toEqual([]);
});

it("places nothing from a read of several channels or no channel", () => {
  const first = message(viewer, source, "One", 20);
  const second = message(viewer, source, "Two", 21);
  placeServed(
    [
      { "#h": [destination], kinds: [9], limit: 1, top_level: true },
      { "#h": [source], kinds: [9], limit: 1, top_level: true },
    ],
    [first],
  );
  placeServed(
    [{ "#h": [destination, source], kinds: [9], limit: 1, top_level: true }],
    [first],
  );
  placeServed([{ ids: [second.id], limit: 1 }], [second]);
  // A broad evidence read of one channel does not say where an event lives.
  placeServed([{ "#h": [destination], kinds: [9], limit: 10 }], [first]);
  expect(channelRowChannel(first)).toBe(source);
  expect(channelRowChannel(second)).toBe(source);
});

it("never places the relay's notices, or an event with two homes", () => {
  const notice = signed(relay, {
    kind: 40099,
    content: JSON.stringify({ type: "member_left", actor: viewer.pubkey }),
    tags: [["h", source]],
  });
  const split = signed(viewer, {
    kind: 9,
    content: "Two homes",
    tags: [
      ["h", source],
      ["h", destination],
    ],
  });
  placeServed(served(destination), [notice, split]);
  expect(channelRowChannel(notice)).toBe(source);
  expect(eventChannel(split)).toBeUndefined();
});

it("lets someone added in the move read what they could not read in the source", () => {
  const moved = message(viewer, source, "Moved", 20);
  const reaction = signed(viewer, {
    kind: 7,
    content: "+",
    tags: [
      ["h", source],
      ["e", moved.id],
    ],
  });
  placeServed(served(destination), [moved, reaction]);
  const visible = eventVisibility(
    (channel) => channel === destination,
    (id) => [moved, reaction].find((event) => event.id === id),
  );
  expect(visible(moved)).toBe(true);
  expect(visible(reaction)).toBe(true);
  // Unplaced, the same events belong to a channel they cannot read.
  const unplaced = message(viewer, source, "Not served", 22);
  expect(
    eventVisibility(
      (channel) => channel === destination,
      () => undefined,
    )(unplaced),
  ).toBe(false);
});

it("shows moved messages in the destination's window and keeps them out of the source's", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport, {
    readStateFloor: () => 0,
    prepared: true,
  });
  const q = owner.session.channels;
  try {
    q.ensureList();
    wire
      .next()
      .respond([
        roster(relay, destination, [viewer.pubkey, other.pubkey]),
        metadata(relay, destination, "Plans"),
      ]);
    await flush();
    q.ensure(destination);
    await flush();
    const moved = message(other, source, "Moved", 20);
    const home = message(viewer, destination, "Home", 21);
    wire.next().respond([
      moved,
      home,
      bounds(relay, destination, "head", {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(q.window(destination).rows.map((row) => row.id)).toEqual([
      moved.id,
      home.id,
    ]);
    // The row's channel is where it is shown, not where it was signed.
    expect(q.window(destination).rows[0]?.channelId).toBe(destination);
  } finally {
    owner.dispose();
  }
});

it("saves a head's placements with it and restores them", async () => {
  const moved = message(other, source, "Moved", 20);
  const home = message(viewer, destination, "Home", 21);
  let saved: SavedHead[] = [];
  const disk: HeadPersistence = {
    read: async () => saved,
    write: async (record) => {
      saved = [record];
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const list = [
    roster(relay, destination, [viewer.pubkey, other.pubkey]),
    metadata(relay, destination, "Plans"),
  ];
  const first = scriptedTransport(viewer.pubkey, relay.pubkey);
  const one = createRelaySession(first.transport, {
    readStateFloor: () => 0,
    prepared: true,
    persistence: disk,
  });
  try {
    one.session.channels.ensureList();
    first.next().respond(list);
    await flush();
    one.session.channels.ensure(destination);
    await flush();
    first.next().respond([
      moved,
      home,
      bounds(relay, destination, "head", {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await vi.waitFor(() => expect(saved[0]?.placed).toEqual([moved.id]));
  } finally {
    one.dispose();
  }
  const second = scriptedTransport(viewer.pubkey, relay.pubkey);
  const two = createRelaySession(second.transport, {
    readStateFloor: () => 0,
    prepared: true,
    persistence: disk,
  });
  try {
    two.session.channels.ensureList();
    second.next().respond(list);
    await flush();
    await flush();
    two.session.channels.ensure(destination);
    await vi.waitFor(() =>
      expect(
        two.session.channels.window(destination).rows.map((row) => row.id),
      ).toEqual([moved.id, home.id]),
    );
  } finally {
    two.dispose();
  }
});
