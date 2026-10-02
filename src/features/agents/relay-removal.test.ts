import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "../relay/session";
import { archiveRelay, keypair, signed, type Key } from "../relay/testing";
import { removeRelayAgent } from "./relay-removal";

const viewer = keypair(),
  relay = keypair(),
  agent = keypair(),
  stranger = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function attested(owner: Key) {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent.pubkey}:`)
    .digest();
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Agent", is_agent: true }),
    tags: [
      [
        "auth",
        owner.pubkey,
        "",
        bytesToHex(schnorr.sign(new Uint8Array(digest), owner.secret)),
      ],
    ],
  });
}
function setup(owner: Key = viewer) {
  const fixture = archiveRelay(
    viewer,
    relay,
    [attested(owner)],
    {},
    {
      [`${"a".repeat(8)}-channel`]: [agent.pubkey, viewer.pubkey],
    },
  );
  const instance = createRelaySession(fixture.transport, {
    outboxStorage: { load: () => [], save: () => {} },
  });
  owners.push(instance);
  const remove = (signal = new AbortController().signal) =>
    removeRelayAgent(instance.session, viewer.pubkey, agent.pubkey, signal);
  return { fixture, instance, remove };
}
const coordinate = () => `30177:${viewer.pubkey}:${agent.pubkey}`;

it("removes channel memberships, deletes the owner record, then archives", async () => {
  const { fixture, instance, remove } = setup();
  await remove();
  expect(fixture.published.map((event) => event.kind)).toEqual([9001, 5, 9035]);
  const deletion = fixture.published[1];
  expect(deletion?.pubkey).toBe(viewer.pubkey);
  expect(deletion?.content).toBe("");
  // The outbox adds its client-id; the native signer admits exactly this shape.
  expect(deletion?.tags).toEqual([
    ["a", coordinate()],
    ["client-id", expect.any(String)],
  ]);
  expect(fixture.deleted).toEqual(new Set([coordinate()]));
  expect(Object.values(fixture.channels).flat()).not.toContain(agent.pubkey);
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
  expect(instance.session.outbox?.snapshot()).toEqual([]);
});

it("without an archive consent path still removes channels and the record", async () => {
  const { fixture, remove } = setup(stranger);
  await remove();
  expect(fixture.published.map((event) => event.kind)).toEqual([9001, 5]);
  expect(fixture.deleted).toEqual(new Set([coordinate()]));
  expect(fixture.archived.has(agent.pubkey)).toBe(false);
});

it("a refused step stops the later steps and a retry finishes them", async () => {
  const { fixture, remove } = setup();
  fixture.removal.fail = new Error("restricted: not authorized");
  await expect(remove()).rejects.toThrow("restricted: not authorized");
  expect(fixture.published).toEqual([]);
  expect(fixture.deleted.size).toBe(0);
  expect(fixture.archived.has(agent.pubkey)).toBe(false);
  delete fixture.removal.fail;
  await remove();
  expect(fixture.published.map((event) => event.kind)).toEqual([9001, 5, 9035]);
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
});

it("a cancelled removal signs and publishes nothing", async () => {
  const { fixture, remove } = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(remove(controller.signal)).rejects.toBeDefined();
  expect(fixture.published).toEqual([]);
  expect(fixture.signedBy).toEqual([]);
});
