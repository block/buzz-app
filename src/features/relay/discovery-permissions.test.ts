import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, metadata, signed } from "./testing";

const relay = keypair(),
  viewer = keypair();
const id = "permissions";
const roster = (role: string, time: number) =>
  signed(relay, {
    kind: 39002,
    content: "",
    created_at: time,
    tags: [
      ["d", id],
      ["p", viewer.pubkey, "", role],
    ],
  });
const details = (role: string, time: number) =>
  metadata(relay, id, "Updates", time, [
    ["public"],
    ["t", "stream"],
    ["join_role", role],
  ]);

it("keeps a guest joined and readable across admission-default changes until explicitly promoted", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("guest", 10));
  state.accept(roster("guest", 10));
  expect(state.channels()).toHaveLength(1);
  expect(state.get(id)).toMatchObject({
    viewerRole: "guest",
    joinRole: "guest",
    readOnly: true,
  });
  expect(state.canAccess(id)).toBe(true);
  expect(state.canParticipate(id)).toBe(true);
  expect(state.canWrite(id)).toBe(false);
  expect(state.suspend(id)).toBe(false);
  state.accept(details("member", 20));
  expect(state.get(id)).toMatchObject({
    viewerRole: "guest",
    joinRole: "member",
    readOnly: true,
  });
  expect(state.canWrite(id)).toBe(false);
  state.accept(roster("member", 20));
  expect(state.get(id)?.readOnly).toBeUndefined();
  expect(state.canWrite(id)).toBe(true);
  state.accept(roster("guest", 30));
  expect(state.canWrite(id)).toBe(false);
  state.accept(roster("member", 20));
  expect(state.canWrite(id)).toBe(false);
});

it.each(["owner", "admin", "member", "bot"])(
  "preserves an existing %s's writing access when the default becomes guest",
  (role) => {
    const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
    state.accept(details("member", 10));
    state.accept(roster(role, 10));
    state.accept(details("guest", 20));
    expect(state.get(id)).toMatchObject({
      viewerRole: role,
      joinRole: "guest",
    });
    expect(state.get(id)?.readOnly).toBeUndefined();
    expect(state.canWrite(id)).toBe(true);
  },
);

it("does not turn a public nonmember or cached guest into a writer", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("member", 10));
  expect(state.canWrite(id)).toBe(false);
  state.accept(roster("guest", 10), true);
  expect(state.canWrite(id)).toBe(false);
  expect(state.get(id)).toMatchObject({
    cached: true,
    readOnly: true,
    viewerRole: "guest",
  });
  state.accept(roster("guest", 10));
  expect(state.get(id)?.cached).toBeUndefined();
  expect(state.canWrite(id)).toBe(false);
});

it("does not grant writing through a contradictory duplicate guest entry", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("member", 10));
  state.accept(
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", id],
        ["p", viewer.pubkey, "", "member"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
  );
  expect(state.get(id)).toMatchObject({ viewerRole: "guest", readOnly: true });
  expect(state.canWrite(id)).toBe(false);
});
