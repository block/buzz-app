import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { ReadError } from "./errors";
import type { RelayEvent } from "./events";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import { matchesEvent } from "./projection";
import { createRelaySession } from "./session";
import { keypair, message, signed } from "./testing";

const gone = "11111111-1111-4111-8111-111111111111";
const kept = "22222222-2222-4222-8222-222222222222";
/** A channel the viewer is not on, and one that does not exist yet. */
const left = "33333333-3333-4333-8333-333333333333";
const unborn = "44444444-4444-4444-8444-444444444444";
const viewer = keypair(),
  relay = keypair(),
  peer = keypair(),
  agent = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
/** A relay holding two private channels the viewer belongs to, with `saved`
 * as the outbox a previous launch left behind, loaded once `loaded` settles.
 * Strong reads answer from the writer; others from a replica that serves
 * `lagging` channels as they were before the viewer joined. */
async function setup(
  saved: readonly OutgoingEvent[] = [],
  loaded?: Promise<void>,
) {
  let archived = false,
    writer = true,
    records = saved,
    receive!: (events: readonly RelayEvent[]) => void,
    deny!: (channelId: string, reason: string) => void;
  const members = new Set([gone, kept]);
  /** Each channel's signed version; a change re-signs only that channel. */
  const versions = new Map([
    [gone, 1_700_000_000],
    [kept, 1_700_000_000],
  ]);
  const at = (id: string) => versions.get(id) ?? 0;
  const bump = (id: string) => versions.set(id, at(id) + 1);
  const lagging = new Set<string>();
  /** Channels whose history reads are refused, with the HTTP status. */
  const refusals = new Map<string, number>();
  const channel = (id: string, replica: boolean) => [
    signed(relay, {
      kind: 39000,
      created_at: at(id),
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
      created_at: at(id),
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "owner"],
        ["p", viewer.pubkey, "admin"],
      ],
    }),
    roster(id, replica),
  ];
  const roster = (id: string, replica = false) =>
    signed(relay, {
      kind: 39002,
      created_at: at(id),
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "", "owner"],
        ...(members.has(id) && !(replica && lagging.has(id))
          ? [["p", viewer.pubkey, "", "admin"]]
          : []),
      ],
    });
  const sign = vi.fn(async (event: EventTemplate) => signed(viewer, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
    if (event.kind === 9022) end(id);
    if (event.kind === 9002) {
      archived = true;
      bump(id);
    }
  });
  function end(id: string) {
    members.delete(id);
    bump(id);
  }
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: { sign, publish },
      channelLifecycle: { sign, publish },
      query: async (filters) => {
        for (const id of filters.flatMap((filter) => filter["#h"] ?? [])) {
          const status = refusals.get(id);
          if (status) throw new ReadError("denied", "Denied", status);
        }
        const strong = filters.some(
          (filter) => filter.consistency === "strong",
        );
        if (strong && !writer)
          throw new ReadError("unavailable", "Writer unreachable");
        return [...channel(gone, !strong), ...channel(kept, !strong)].filter(
          (event) => filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      subscribe(callbacks) {
        receive = callbacks.receive;
        deny = callbacks.denied;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      outboxStorage: {
        load: () => (loaded ? loaded.then(() => records) : records),
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
  if (!loaded) await outbox.ready();
  return {
    ...owner,
    outbox,
    publish,
    lag: (id: string) => lagging.add(id),
    refuse: (id: string, status: number) => refusals.set(id, status),
    deny: (id: string) => deny(id, "restricted: not a channel member"),
    writerDown() {
      writer = false;
    },
    /** The ids pending in the outbox and in its storage, which must agree. */
    pending: () => [
      outbox.snapshot().map((item) => item.event.id),
      records.map((item) => item.event.id),
    ],
    /** Someone else removes the viewer; `seen` is how this device learns. */
    async remove(
      id: string,
      seen: "live roster" | "roster refresh" | "strong roster refresh",
    ) {
      end(id);
      if (seen === "live roster") receive([roster(id)]);
      else
        owner.session.channels.refreshList?.(
          seen === "strong roster refresh" ? { consistency: "strong" } : {},
        );
      await vi.waitFor(() =>
        expect(
          owner.session.channels.list().channels.map((item) => item.id),
        ).not.toContain(id),
      );
    },
    /** Someone adds the viewer back, seen through the live roster. */
    async rejoin(id: string) {
      members.add(id);
      bump(id);
      receive([roster(id)]);
      await vi.waitFor(() =>
        expect(
          owner.session.channels.list().channels.map((item) => item.id),
        ).toContain(id),
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

/** Sends to `gone` and holds the attempt until `end` rejects it. */
async function inFlight(h: Awaited<ReturnType<typeof setup>>) {
  let end!: (error: Error) => void;
  h.publish.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        end = reject;
      }),
  );
  const id = h.session.messages.send(gone, "In flight");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  return { id, end: (error: Error) => end(error) };
}

it("discards a send the relay refuses after removal ends membership", async () => {
  const h = await setup();
  const send = await inFlight(h);
  try {
    await h.remove(gone, "live roster");
    expect(h.outbox.snapshot()).toMatchObject([
      { event: { id: send.id }, delivery: "sending" },
    ]);
  } finally {
    send.end(new PublishRejected("restricted: not a member"));
  }
  await vi.waitFor(() => expect(h.pending()).toEqual([[], []]));
});

it.each([
  ["the viewer is back before it is refused", "failed"],
  ["it may have reached the relay", "unknown"],
] as const)("keeps an in-flight send when %s", async (_, delivery) => {
  const elsewhere = failed(kept, "Removed later");
  const h = await setup([elsewhere]);
  const send = await inFlight(h);
  try {
    await h.remove(gone, "live roster");
    if (delivery === "failed") await h.rejoin(gone);
  } finally {
    send.end(
      delivery === "failed"
        ? new PublishRejected("restricted: not a member")
        : new Error("Connection lost"),
    );
  }
  await vi.waitFor(() =>
    expect(
      h.outbox.snapshot().find((item) => item.event.id === send.id)?.delivery,
    ).toBe(delivery),
  );
  // A later removal's discard is the barrier: outbox writes run in order.
  await h.remove(kept, "live roster");
  await vi.waitFor(() => expect(h.pending()).toEqual([[send.id], [send.id]]));
});

it("discards a left channel's failed sends once restored sends load", async () => {
  let load!: () => void;
  const loaded = new Promise<void>((resolve) => {
    load = resolve;
  });
  const stranded = failed(gone, "Restored late");
  const elsewhere = failed(kept, "Still retryable");
  const h = await setup([stranded, elsewhere], loaded);
  // With no writer to confirm a roster read, only the live removal discards.
  h.writerDown();
  try {
    await h.remove(gone, "live roster");
    expect(h.outbox.snapshot()).toEqual([]);
  } finally {
    load();
  }
  const remaining = [elsewhere.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});

it("keeps failed sends in a channel only a lagging replica leaves out", async () => {
  const unsent = failed(gone, "Never sent");
  const lagged = failed(kept, "Writer still lists the viewer");
  const h = await setup([unsent, lagged]);
  h.lag(kept);
  await h.remove(gone, "roster refresh");
  // One writer read confirms both omissions, so gone's discard decides kept's.
  const remaining = [lagged.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});

it.each([
  ["a 401 history read", "keeps"],
  ["a 403 history read", "discards"],
  ["a live not-a-member refusal", "discards"],
] as const)("%s %s the channel's failed sends", async (how, outcome) => {
  const unsent = failed(gone, "Never sent");
  const elsewhere = failed(kept, "Removed later");
  const h = await setup([unsent, elsewhere]);
  if (how === "a live not-a-member refusal") h.deny(gone);
  else {
    h.refuse(gone, how === "a 401 history read" ? 401 : 403);
    h.session.channels.ensure(gone);
  }
  await vi.waitFor(() =>
    expect(
      h.session.channels.list().channels.map((item) => item.id),
    ).not.toContain(gone),
  );
  // The writer still lists the viewer after a 401, but discovery keeps the
  // denial. One writer read decides both channels, so kept's discard is the
  // barrier for gone's.
  await h.remove(kept, "strong roster refresh");
  const remaining = outcome === "keeps" ? [unsent.event.id] : [];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});

it("discards failed sends an earlier session left in a channel the viewer is not on", async () => {
  const stray = failed(left, "Sent before leaving");
  // Sent to channels the viewer is not on: a create, and removing its agent.
  const create: OutgoingEvent = {
    event: signed(viewer, {
      kind: 9007,
      content: "",
      tags: [
        ["h", unborn],
        ["name", "New"],
      ],
    }),
    delivery: "failed",
  };
  const removal: OutgoingEvent = {
    event: signed(viewer, {
      kind: 9001,
      content: "",
      tags: [
        ["h", left],
        ["p", agent.pubkey],
      ],
    }),
    delivery: "failed",
  };
  const h = await setup([stray, create, removal]);
  const remaining = [create.event.id, removal.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
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
