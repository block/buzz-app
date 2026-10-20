import { afterEach, expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { createProfileDirectory } from "./profile-directory";
import { createChannelStore } from "./store";
import { keypair, metadata, roster } from "./testing";

const relay = keypair();
const viewer = keypair();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("derives a sorted member list without changing readable order or losing system access", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey, 3);
  for (const [id, type] of [
    ["b", "stream"],
    ["records", "system"],
    ["a", "dm"],
    ["overflow", "stream"],
  ]) {
    if (!id || !type) throw new Error("Missing fixture coordinate");
    state.accept(roster(relay, id, [viewer.pubkey]));
    state.accept(metadata(relay, id, "Same 🐝", 10, [["t", type]]));
  }
  const readable = Object.freeze(state.readable());
  const listed = state.channels(readable);
  expect(readable.map((channel) => channel.id)).toEqual(["b", "records", "a"]);
  expect(listed.map((channel) => channel.id)).toEqual(["a", "b"]);
  expect(listed).toEqual(state.channels());
  expect(state.canParticipate("records")).toBe(true);
  expect(state.get("overflow")).toBeUndefined();
  expect(state.overflowRevision).toBe(2);
});

it("preserves duplicate snapshot identity, replacement ordering and cached/revoked authority in the store", () => {
  const reader = {
    read: async () => {
      throw new Error("This synchronous fixture must not read");
    },
  };
  const directory = createProfileDirectory(reader);
  const owner = createChannelStore(
    {
      ...reader,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      visible: (events) => events,
      revokeAccess: (commit) => commit(),
    },
    directory,
    { now: () => 1000 },
  );
  cleanups.push(() => {
    owner.dispose();
    directory.dispose();
  });
  const members = roster(relay, "work", [viewer.pubkey], 10);
  const names = metadata(relay, "work", "Old", 10, [["t", "stream"]]);
  owner.acceptDiscovery([members, names], undefined, undefined, true);
  expect(owner.queries.get?.("work")).toMatchObject({
    cached: true,
    readOnly: true,
  });
  expect(owner.canAccess("work")).toBe(true);
  expect(owner.canParticipate("work")).toBe(false);

  owner.acceptDiscovery([members]);
  expect(owner.canParticipate("work")).toBe(true);
  const confirmed = owner.queries.list();
  expect(Object.isFrozen(confirmed)).toBe(true);
  expect(Object.isFrozen(confirmed.channels)).toBe(true);
  expect(Object.isFrozen(confirmed.channels[0])).toBe(true);
  owner.acceptDiscovery([members, names]);
  expect(owner.queries.list()).toBe(confirmed);

  const newer = metadata(relay, "work", "New", 11, [["t", "stream"]]);
  owner.acceptDiscovery([newer]);
  expect(owner.queries.list().channels[0]?.name).toBe("New");
  owner.acceptDiscovery([names]);
  expect(owner.queries.list().channels[0]?.name).toBe("New");
  const loss = roster(relay, "work", [], 12);
  let observedLoss = false;
  const stop = owner.queries.subscribeList(() => {
    observedLoss = true;
    expect(owner.canAccess("work")).toBe(false);
    expect(owner.queries.get?.("work")).toBeUndefined();
    expect(owner.queries.list().channels).toEqual([]);
  });
  owner.acceptDiscovery([loss]);
  stop();
  expect(observedLoss).toBe(true);
  owner.acceptDiscovery([members]);
  expect(owner.canParticipate("work")).toBe(false);
  owner.acceptDiscovery([roster(relay, "work", [viewer.pubkey], 13)]);
  expect(owner.canParticipate("work")).toBe(true);
});
