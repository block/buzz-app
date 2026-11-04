// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "../relay/read-state-storage";
import type { RelayEvent } from "../relay/events";
import { flush, keypair, message, metadata, roster } from "../relay/testing";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";
import { createReadingOwner, createReadingProxy } from "./reading-bridge";

const owners: ReturnType<typeof createRelaySession>[] = [];
const bridges: { dispose(): void }[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const owner of owners.splice(0)) owner.dispose();
});

/** A real session with signed read state whose storage save can be held. */
function setup() {
  const viewer = keypair();
  const relay = keypair();
  const alice = keypair();
  let journal: ReadJournal | undefined = newReadJournal();
  let hold: { started(): void; wait: Promise<void> } | undefined;
  const storage: ReadStateStorage = {
    async update(change) {
      if (hold) {
        const { started, wait } = hold;
        hold = undefined;
        started();
        await wait;
      }
      journal = readJournal(change(journal), viewer.pubkey);
      return journal;
    },
    close() {},
  };
  let incoming: (events: readonly RelayEvent[]) => void = () => {};
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query: vi.fn(async () => []),
      media: () => undefined,
      readState: {
        decode: async (events: readonly RelayEvent[]) =>
          decodeReadState(events, viewer.secret),
        sign: async (intent: unknown) => signReadState(intent, viewer.secret),
        publish: async () => {},
      },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateStorage: storage,
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  owners.push(owner);
  incoming([
    roster(relay, "room", [viewer.pubkey], 10),
    metadata(relay, "room", "room", 10),
  ]);
  const row = message(alice, "room", "hello", 11, [["p", viewer.pubkey]]);
  incoming([row]);
  return {
    session: owner.session,
    row,
    unread: () => owner.session.unread.attention("room", row.id).unread,
    holdSave() {
      let release = () => {};
      let started = () => {};
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { started, wait };
      return { started: startedPromise, release };
    },
  };
}
function bridge(
  h: ReturnType<typeof setup>,
  known = () => new Set([h.row.id]),
) {
  const owner = createReadingOwner(
    h.session.unread,
    "room",
    h.row.id,
    known,
    () => true,
  );
  const proxy = createReadingProxy(owner.token, () => true);
  bridges.push(owner, proxy);
  return proxy.unread;
}

it("completes a companion observation only after main's save is durable", async () => {
  const h = setup();
  await flush();
  expect(h.unread()).toBe(true);
  const unread = bridge(h);
  const gate = h.holdSave();
  const lease = unread.reading("room");
  const observed = lease.observe([h.row.id]);
  await gate.started;
  // The caller still awaits; disposing now would be a bug in the caller, not
  // in the bridge, so the lease survives until the save completes.
  gate.release();
  await observed;
  lease.dispose();
  await flush();
  expect(h.unread()).toBe(false);
});

it("keeps the cancellation fence: disposing before durability records nothing", async () => {
  const h = setup();
  await flush();
  const unread = bridge(h);
  const gate = h.holdSave();
  const lease = unread.reading("room");
  const observed = lease.observe([h.row.id]);
  await gate.started;
  lease.dispose(); // blur/hide/manual unread while the save is still pending
  await flush(); // the disposal reaches main before its save resumes
  gate.release();
  await observed.catch(() => {});
  await flush();
  expect(h.unread()).toBe(true);
});

it("claims nothing outside the window's projection and reports lease loss", async () => {
  const h = setup();
  await flush();
  const unread = bridge(h, () => new Set());
  const lease = unread.reading("room");
  await lease.observe([h.row.id]);
  expect(h.unread()).toBe(true);
  lease.dispose();
  await expect(lease.observe([h.row.id])).rejects.toThrow(/lease ended/);
});

it("rejects a delayed observation once the lease was disposed in main", async () => {
  const h = setup();
  await flush();
  const owner = createReadingOwner(
    h.session.unread,
    "room",
    h.row.id,
    () => new Set([h.row.id]),
    () => true,
  );
  bridges.push(owner);
  // The wire itself: a request that left the companion before blur disposed
  // its lease but reaches main afterward must not revive reading intent.
  const wire = new BroadcastChannel(`buzz.popout.reading.${owner.token}`);
  const results: { id: number; error?: string }[] = [];
  wire.onmessage = ({ data }) => {
    if (data.kind === "result") results.push(data);
  };
  wire.postMessage({ kind: "acquire", lease: "L1" });
  wire.postMessage({ kind: "dispose", lease: "L1" });
  wire.postMessage({ kind: "observe", id: 7, lease: "L1", ids: [h.row.id] });
  await vi.waitFor(() => expect(results).toHaveLength(1));
  expect(results[0]).toMatchObject({ id: 7, error: "Reading lease ended." });
  expect(h.unread()).toBe(true);
  wire.close();
});
