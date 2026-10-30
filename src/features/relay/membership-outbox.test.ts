import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import { matchesEvent } from "./projection";
import { createRelaySession } from "./session";
import { keypair, message, signed } from "./testing";

const gone = "11111111-1111-4111-8111-111111111111";
const kept = "22222222-2222-4222-8222-222222222222";
const viewer = keypair(),
  relay = keypair(),
  peer = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
/** A relay holding two private channels the viewer belongs to, with `saved`
 * as the outbox a previous launch left behind. */
async function setup(saved: readonly OutgoingEvent[] = []) {
  let time = 1_700_000_000,
    archived = false,
    records = saved,
    receive!: (events: readonly RelayEvent[]) => void;
  const members = new Set([gone, kept]);
  const channel = (id: string) => [
    signed(relay, {
      kind: 39000,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ["name", id === gone ? "Gone" : "Kept"],
        ["t", "stream"],
        ...(archived && id === gone ? [["archived", "true"]] : []),
      ],
    }),
    signed(relay, {
      kind: 39001,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "owner"],
        ["p", viewer.pubkey, "admin"],
      ],
    }),
    roster(id),
  ];
  const roster = (id: string) =>
    signed(relay, {
      kind: 39002,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "", "owner"],
        ...(members.has(id) ? [["p", viewer.pubkey, "", "admin"]] : []),
      ],
    });
  const sign = vi.fn(async (event: EventTemplate) => signed(viewer, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
    if (event.kind === 9022) end(id);
    if (event.kind === 9002) {
      archived = true;
      time++;
    }
  });
  function end(id: string) {
    members.delete(id);
    time++;
  }
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: { sign, publish },
      channelLifecycle: { sign, publish },
      query: async (filters) =>
        [...channel(gone), ...channel(kept)].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      outboxStorage: {
        load: () => records,
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  owners.push(owner);
  owner.session.channels.refreshList?.();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(2),
  );
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  await outbox.ready();
  return {
    ...owner,
    outbox,
    publish,
    /** The ids pending in the outbox and in its storage, which must agree. */
    pending: () => [
      outbox.snapshot().map((item) => item.event.id),
      records.map((item) => item.event.id),
    ],
    /** Someone else removes the viewer; `seen` is how this device learns. */
    async remove(id: string, seen: "live roster" | "roster refresh") {
      end(id);
      if (seen === "live roster") receive([roster(id)]);
      else owner.session.channels.refreshList?.();
      await vi.waitFor(() =>
        expect(
          owner.session.channels.list().channels.map((item) => item.id),
        ).not.toContain(id),
      );
    },
  };
}

const failed = (channelId: string, content: string): OutgoingEvent => ({
  event: message(viewer, channelId, content, 1_700_000_000),
  delivery: "failed",
  error: "restricted: slow down",
});

it.each(["leave", "live roster", "roster refresh"] as const)(
  "ending membership by %s discards that channel's failed sends only",
  async (how) => {
    const stranded = failed(gone, "Never sent");
    const unconfirmed: OutgoingEvent = {
      event: message(viewer, gone, "Maybe sent", 1_700_000_000),
      delivery: "unknown",
    };
    const elsewhere = failed(kept, "Still retryable");
    const h = await setup([stranded, unconfirmed, elsewhere]);
    if (how === "leave") await h.session.channelLifecycle.run("leave", gone);
    else await h.remove(gone, how);
    const remaining = [unconfirmed.event.id, elsewhere.event.id];
    await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
  },
);

it("discards a send the relay refuses after removal ends membership", async () => {
  const h = await setup();
  let refuse!: () => void;
  h.publish.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        refuse = () => reject(new PublishRejected("restricted: not a member"));
      }),
  );
  const id = h.session.messages.send(gone, "In flight");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  try {
    await h.remove(gone, "live roster");
    expect(h.outbox.snapshot()).toMatchObject([
      { event: { id }, delivery: "sending" },
    ]);
  } finally {
    refuse();
  }
  await vi.waitFor(() => expect(h.pending()).toEqual([[], []]));
});

it("keeps failed sends in a channel the viewer archives", async () => {
  const archived = failed(gone, "Still viewable");
  const h = await setup([archived, failed(kept, "Removed later")]);
  await h.session.channelLifecycle.run("archive", gone);
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([9002]);
  // A later removal's discard is the barrier: outbox writes run in order.
  await h.remove(kept, "live roster");
  const remaining = [archived.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});
