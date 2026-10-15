import { expect, it, vi } from "vitest";
import type { RelayEvent } from "./events";
import type { HeadPersistence } from "./persistence";
import { createRelaySession } from "./session";
import {
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair();
const system = "33333333-3333-4333-8333-333333333333",
  other = "22222222-2222-4222-8222-222222222222";
const systemRoster = (created_at = 1_700_000_000): RelayEvent =>
  signed(relay, {
    kind: 39002,
    content: "",
    created_at,
    tags: [
      ["d", system],
      ["t", "system"],
      ["p", viewer.pubkey],
    ],
  });
const systemMetadata = metadata(relay, system, "For You records", undefined, [
  ["private"],
  ["hidden"],
  ["t", "system"],
  ["t", "for-you"],
]);

/** One NIP-CL full pass: system rosters, the `#p` roster read, then names. */
async function pass(
  owner: ReturnType<typeof createRelaySession>,
  wire: ReturnType<typeof scriptedTransport>,
  systemRosters: readonly RelayEvent[],
) {
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  const systemRead = wire.next();
  expect(systemRead.filters).toEqual([
    expect.objectContaining({
      kinds: [39002],
      "#p": [viewer.pubkey],
      "#t": ["system"],
    }),
  ]);
  systemRead.respond([...systemRosters]);
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  const rosterRead = wire.next();
  expect(rosterRead.filters[0]).not.toHaveProperty("#t");
  rosterRead.respond([roster(relay, other, [viewer.pubkey])]);
  // Names for any channel this pass found without them, until it verifies.
  await vi.waitFor(() => {
    for (const request of wire.pending.splice(0))
      request.respond(
        (request.filters[0]?.["#d"] ?? []).map((id) =>
          id === system
            ? systemMetadata
            : metadata(relay, id, "Existing", undefined, [["public"]]),
        ),
      );
    expect(owner.session.live.snapshot().roster.state).toBe("verified");
  });
}

it("loses a system channel when a later full pass no longer lists the viewer", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    channelIdentity: true,
  });
  const channels = owner.session.channels;
  try {
    channels.ensureList();
    await pass(owner, wire, [systemRoster()]);
    expect(channels.get?.(system)).toMatchObject({ channelType: "system" });
    expect(channels.list().channels.map((channel) => channel.id)).toEqual([
      other,
    ]);
    // The owner removed the viewer: the system read no longer returns it.
    channels.refreshList?.();
    await pass(owner, wire, []);
    await vi.waitFor(() => expect(channels.get?.(system)).toBeUndefined());
    expect(channels.list().channels.map((channel) => channel.id)).toEqual([
      other,
    ]);
  } finally {
    owner.dispose();
  }
});

it("clears a restored system channel the first full pass does not return", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [systemRoster(), systemMetadata],
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(
    { ...wire.transport, channelIdentity: true },
    { persistence, prepared: true },
  );
  const channels = owner.session.channels;
  try {
    await owner.restore();
    expect(channels.get?.(system)).toMatchObject({
      channelType: "system",
      cached: true,
    });
    channels.ensureList();
    await pass(owner, wire, []);
    await vi.waitFor(() => expect(channels.get?.(system)).toBeUndefined());
  } finally {
    owner.dispose();
  }
});

it("keeps a restored system channel the first full pass returns", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [systemRoster(), systemMetadata],
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(
    { ...wire.transport, channelIdentity: true },
    { persistence, prepared: true },
  );
  const channels = owner.session.channels;
  try {
    await owner.restore();
    channels.ensureList();
    await pass(owner, wire, [systemRoster()]);
    expect(channels.get?.(system)).toMatchObject({ channelType: "system" });
    expect(channels.get?.(system)?.cached).toBeUndefined();
    expect(channels.list().channels.map((channel) => channel.id)).toEqual([
      other,
    ]);
  } finally {
    owner.dispose();
  }
});
