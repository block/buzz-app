import { expect, it } from "vitest";
import {
  keypair,
  signed,
  roster,
  metadata,
  scriptedTransport,
  bounds,
  flush,
} from "../relay/testing";
import { createRelaySession } from "../relay/session";
import { huddleDescription, huddleLifecycle } from "./lifecycle";
const parent = "00000000-0000-4000-8000-000000000001",
  room = "00000000-0000-4000-8000-000000000002";
const author = keypair(),
  relay = keypair(),
  stranger = keypair();
const event = (kind: number, key = relay, at = 20) =>
  signed(key, {
    kind,
    created_at: at,
    content: JSON.stringify({ ephemeral_channel_id: room }),
    tags: [
      ["h", parent],
      ["p", author.pubkey],
    ],
  });

it("projects actual Huddle history cards and marked room metadata through the relay session", async () => {
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, parent, [author.pubkey]),
        roster(relay, room, [author.pubkey]),
        metadata(relay, parent, "Design"),
        metadata(relay, room, "Huddle", 30, [
          ["private"],
          ["about", huddleDescription(parent)],
        ]),
      ]);
    await flush();
    expect(
      owner.session.channels.list().channels.find((c) => c.id === room),
    ).toMatchObject({ huddle: true, parentChannelId: parent });
    owner.session.channels.ensure(parent);
    const head = wire.next();
    expect(head.filters[0]?.kinds).toEqual(
      expect.arrayContaining([48100, 48103]),
    );
    head.respond([
      event(48100, author, 10),
      event(48103, relay, 30),
      event(48103, stranger, 31),
      bounds(relay, parent, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(
      owner.session.channels.window(parent).rows.map((row) => row.huddle),
    ).toEqual([
      { room, state: "started" },
      { room, state: "ended" },
    ]);
  } finally {
    owner.dispose();
  }
});

it("ignores forged participation/end and preserves an authoritative end across later joins", () => {
  const start = event(48100, author, 10),
    join = event(48101, relay, 20);
  expect(
    huddleLifecycle(
      [start, join, event(48102, stranger, 21), event(48103, stranger, 22)],
      room,
      parent,
      relay.pubkey,
    ),
  ).toEqual({
    startedAt: 10,
    endedAt: undefined,
    participants: [author.pubkey],
  });
  expect(
    huddleLifecycle(
      [event(48101, relay, 40), event(48103, relay, 30), join, start],
      room,
      parent,
      relay.pubkey,
    ).endedAt,
  ).toBe(30);
});
