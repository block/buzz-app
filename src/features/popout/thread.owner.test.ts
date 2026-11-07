// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { createPopoutThread } from "./thread";

const clean: (() => void)[] = [];
afterEach(() => {
  for (const dispose of clean.splice(0)) dispose();
});

/** A signed kind 0 for `agent` carrying a NIP-OA owner attestation by `owner`. */
async function agentProfile(
  agent: ReturnType<typeof keypair>,
  owner: ReturnType<typeof keypair>,
) {
  const conditions = "kind=0&created_at<1700000001";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nostr:agent-auth:${agent.pubkey}:${conditions}`),
  );
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Agent" }),
    tags: [
      [
        "auth",
        owner.pubkey,
        conditions,
        bytesToHex(schnorr.sign(new Uint8Array(digest), owner.secret)),
      ],
    ],
  });
}

async function setup(ownedByViewer: boolean) {
  const relay = keypair();
  const viewer = keypair();
  const agent = keypair();
  const stranger = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const store = createRelaySession(
    {
      ...wire.transport,
      // A writer gives the session an outbox, as deletion requires.
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  clean.push(store.dispose);
  const profile = await agentProfile(agent, ownedByViewer ? viewer : stranger);
  const root = message(viewer, "channel", "Root", 1);
  const reply = {
    ...message(agent, "channel", "From the agent", 2, [
      ["e", root.id, "", "reply"],
    ]),
  };
  live.receive([
    roster(relay, "channel", [viewer.pubkey, agent.pubkey]),
    root,
    reply,
    profile,
  ]);
  const thread = createPopoutThread(
    store.session,
    "channel",
    root.id,
    () => {},
  );
  clean.push(thread.dispose);
  // The thread's own read, then the owner-evidence read for the agent.
  await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
  while (wire.pending.length) {
    const read = wire.next();
    const kinds = read.filters[0]?.kinds ?? [];
    read.respond(kinds.includes(0) ? [profile] : [root, reply]);
    await flush();
  }
  /** Answer reads the owner-evidence observation issues once rows are shown. */
  const settleReads = async () => {
    for (let i = 0; i < 5; i++) {
      await flush();
      while (wire.pending.length) {
        const read = wire.next();
        const kinds = read.filters[0]?.kinds ?? [];
        read.respond(kinds.includes(0) ? [profile] : [root, reply]);
      }
    }
  };
  return { thread, agent, reply, viewer, wire, profile, settleReads };
}

it("lets the viewer delete an owned agent's message once main's evidence is ready, and only then", async () => {
  const h = await setup(true);
  await vi.waitFor(() => expect(h.thread.snapshot().status).toBe("ready"));
  // Showing the agent's row starts the evidence observation; its read and the
  // signature verification settle asynchronously, then the row's policy and
  // the owner-side authorization agree.
  await h.settleReads();
  await vi.waitFor(() =>
    expect(h.thread.snapshot().replies[0]?.management?.canDelete).toBe(true),
  );
  expect(h.thread.authorization(h.reply.id)).toEqual({
    agentId: h.agent.pubkey,
    ownerId: h.viewer.pubkey,
  });
  // Not the viewer's own: no edit, no send-to-channel.
  expect(h.thread.snapshot().replies[0]?.management?.canEdit).toBe(false);
});

it("grants nothing for an agent owned by someone else, or before evidence is ready", async () => {
  const h = await setup(false);
  await vi.waitFor(() => expect(h.thread.snapshot().status).toBe("ready"));
  await h.settleReads();
  await flush();
  expect(h.thread.snapshot().replies[0]?.management?.canDelete).toBe(false);
  expect(h.thread.authorization(h.reply.id)).toBeUndefined();
});
