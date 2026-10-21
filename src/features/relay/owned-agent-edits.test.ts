import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import { eventDto, type RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import { createProfileDirectory } from "./profile-directory";
import { createRelayReader } from "./reader";
import { foldMessages } from "./fold";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler } from "./profiling";
import { keypair, message, roster, scriptedTransport, signed } from "./testing";

it("admits owner edits only after verifying the current signed profile, and revokes replaced evidence", async () => {
  const owner = keypair(),
    agent = keypair(),
    stranger = keypair(),
    relay = keypair();
  const wire = scriptedTransport(owner.pubkey, relay.pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const auth = (key = owner) => [
    "auth",
    key.pubkey,
    "",
    bytesToHex(
      schnorr.sign(
        createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest(),
        key.secret,
      ),
    ),
  ];
  const profile = eventDto(
    signed(agent, { kind: 0, created_at: 10, content: "{}", tags: [auth()] }),
  );
  const original = message(agent, "c", "Whole answer", 11);
  const edit = signed(owner, {
    kind: 40003,
    content: "Spoken",
    created_at: 12,
    tags: [
      ["h", "c"],
      ["e", original.id],
    ],
  });
  const projection = new MessageProjection(
    "c",
    relay.pubkey,
    createRelayProfiler(),
    undefined,
    undefined,
    directory.queries.owner,
  );
  const rows = () => projection.reconcile([original, edit], []);
  try {
    expect(rows()[0]?.content).toBe("Whole answer");
    directory.accept([profile]);
    await vi.waitFor(() =>
      expect(directory.queries.owner?.(agent.pubkey)).toBe(owner.pubkey),
    );
    expect(rows()[0]?.content).toBe("Spoken");
    expect(
      foldMessages(
        "c",
        relay.pubkey,
        [
          original,
          signed(stranger, {
            kind: 40003,
            content: "Forged",
            created_at: 14,
            tags: [
              ["h", "c"],
              ["e", original.id],
            ],
          }),
        ],
        { agentOwner: directory.queries.owner },
      )[0]?.content,
    ).toBe("Whole answer");
    directory.accept([
      eventDto(
        signed(agent, { kind: 0, created_at: 13, content: "{}", tags: [] }),
      ),
    ]);
    expect(rows()[0]?.content).toBe("Whole answer");
    directory.accept([profile]);
    expect(rows()[0]?.content).toBe("Whole answer");
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("publishes an owned-agent edit through the real session and refuses a foreign agent", async () => {
  const owner = keypair(),
    agent = keypair(),
    stranger = keypair(),
    relay = keypair();
  const wire = scriptedTransport(owner.pubkey, relay.pubkey);
  const published: RelayEvent[] = [];
  let live!: LiveCallbacks;
  const connection = createRelaySession(
    {
      ...wire.transport,
      archiveAuthority: relay.pubkey,
      writer: {
        sign: async (template) => signed(owner, template),
        publish: async (event) => {
          published.push(event);
        },
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  const profile = (author: typeof agent, controller: typeof owner) =>
    eventDto(
      signed(author, {
        kind: 0,
        created_at: 10,
        content: "{}",
        tags: [
          [
            "auth",
            controller.pubkey,
            "",
            bytesToHex(
              schnorr.sign(
                createHash("sha256")
                  .update(`nostr:agent-auth:${author.pubkey}:`)
                  .digest(),
                controller.secret,
              ),
            ),
          ],
        ],
      }),
    );
  const original = message(agent, "c", "Whole answer", 11);
  const foreign = message(stranger, "c", "Foreign answer", 11);
  try {
    connection.session.channels.ensure("c");
    live.receive([
      roster(relay, "c", [owner.pubkey, agent.pubkey, stranger.pubkey], 1),
      original,
      foreign,
      profile(agent, owner),
      profile(stranger, stranger),
    ]);
    await connection.session.outbox?.ready();
    await expect(
      connection.session.messages.editOwnedAgent(
        foreign.id,
        "Forged",
        foreign.id,
      ),
    ).rejects.toThrow("verified owner");
    expect(published.filter((event) => event.kind === 40003)).toEqual([]);
    const id = await connection.session.messages.editOwnedAgent(
      original.id,
      "Spoken",
      original.id,
    );
    await vi.waitFor(() =>
      expect(published.some((event) => event.id === id)).toBe(true),
    );
    const edit = published.find((event) => event.id === id);
    if (!edit) throw new Error("Missing owner edit");
    expect(edit).toMatchObject({
      kind: 40003,
      pubkey: owner.pubkey,
      content: "Spoken",
    });
    expect(edit.tags).toContainEqual(["e", original.id]);
    live.receive([edit]);
    await vi.waitFor(() =>
      expect(
        connection.session.channels
          .window("c")
          .rows.find((row) => row.id === original.id)?.content,
      ).toBe("Spoken"),
    );
    const removed = await connection.session.messages.editOwnedAgent(
      original.id,
      "",
      original.id,
    );
    await vi.waitFor(() =>
      expect(
        published.some((event) => event.id === removed && event.kind === 5),
      ).toBe(true),
    );
  } finally {
    connection.dispose();
  }
});
