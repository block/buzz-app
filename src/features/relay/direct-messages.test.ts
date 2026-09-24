import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, type EventTemplate } from "nostr-tools";
import { createDirectMessages } from "./direct-messages";
import type { ChannelList, ChannelQueries } from "./contracts";
import { createRelaySession } from "./session";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import type { RelayEvent } from "./events";
import { keypair, roster, signed } from "./testing";

const canonical = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const sessions: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of sessions.splice(0)) owner.dispose();
});

type Channel = { members: string[]; type: string; listed: boolean };
/** Relay-authored rosters/metadata plus a scriptable 41010 publisher. */
function relayFixture(
  records: OutgoingEvent[] = [],
  viewer = keypair(),
  peer = keypair(),
) {
  const relay = keypair();
  const channels = new Map<string, Channel>();
  const events = () =>
    [...channels].flatMap(([id, channel]) =>
      channel.listed
        ? [
            roster(relay, id, channel.members),
            signed(relay, {
              kind: 39000,
              content: "",
              tags: [
                ["d", id],
                ["name", "DM"],
                ["t", channel.type],
                ["hidden"],
                ["private"],
              ],
            }),
          ]
        : [],
    );
  const published: RelayEvent[] = [];
  let respond: (event: RelayEvent) => Promise<string> = async () =>
    `response:${JSON.stringify({ channel_id: canonical, created: true })}`;
  let storage = records;
  let hold: Promise<void> | undefined;
  let metadata: Promise<void> | undefined;
  let failSaves = false;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) => {
        if (filters.some((filter) => filter.kinds?.includes(39002)))
          return events().filter((event) => event.kind === 39002);
        if (!filters.some((filter) => filter.kinds?.includes(39000))) return [];
        await metadata;
        return events().filter((event) => event.kind === 39000);
      },
      writer: {
        kinds: [9, 41010],
        sign: async (template: EventTemplate) =>
          finalizeEvent({ ...template }, viewer.secret),
        publish: async (event: RelayEvent) => {
          published.push(event);
          return respond(event);
        },
      },
    },
    {
      outboxStorage: {
        load: () => structuredClone(storage),
        save: async (next) => {
          await hold;
          if (failSaves) throw new Error("disk full");
          storage = structuredClone([...next]);
        },
      },
    },
  );
  sessions.push(owner);
  return {
    viewer,
    peer,
    owner,
    channels,
    published,
    records: () => storage,
    /** Hold journal saves until the returned release runs. */
    holdSaves() {
      let release = () => {};
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release();
      };
    },
    /** Hold 39000 metadata reads until the returned release runs. */
    holdMetadata() {
      let release = () => {};
      metadata = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        metadata = undefined;
        release();
      };
    },
    failSaves(next: boolean) {
      failSaves = next;
    },
    respondWith(next: typeof respond) {
      respond = next;
    },
    dm(id: string, listed = true) {
      channels.set(id, {
        members: [viewer.pubkey, peer.pubkey],
        type: "dm",
        listed,
      });
    },
  };
}

it("opens a listed DM through the relay's idempotent 41010", async () => {
  const f = relayFixture();
  f.dm(canonical);
  f.owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(f.owner.session.channels.list().channels).toHaveLength(1),
  );
  f.respondWith(
    async () => `response:{"channel_id":"${canonical}","created":false}`,
  );
  await expect(
    f.owner.session.directMessages.open(f.peer.pubkey),
  ).resolves.toBe(canonical);
  expect(f.published.map((event) => event.kind)).toEqual([41010]);
});

it("creates a DM and returns the relay's canonical ID after roster readback", async () => {
  const f = relayFixture();
  f.respondWith(async () => {
    f.dm(canonical); // The relay's participant-set ID, not the request UUID.
    return `response:${JSON.stringify({ channel_id: canonical, created: true })}`;
  });
  await expect(
    f.owner.session.directMessages.open(f.peer.pubkey),
  ).resolves.toBe(canonical);
  const [command] = f.published;
  expect(command?.kind).toBe(41010);
  expect(command?.tags.filter(([name]) => name === "p")).toEqual([
    ["p", f.peer.pubkey],
  ]);
  const request = command?.tags.find(([name]) => name === "d")?.[1];
  expect(request).toMatch(/^[0-9a-f-]{36}$/);
  expect(request).not.toBe(canonical);
  await vi.waitFor(() => expect(f.records()).toEqual([]));
  expect(JSON.stringify(f.records())).not.toContain(canonical);
});

it("reopens a relay-hidden DM that the signed roster still lists", async () => {
  const f = relayFixture();
  // Relay-side hide (41012) keeps 39002 membership; only 41010 clears it.
  f.dm(canonical);
  f.owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(f.owner.session.channels.list().channels).toHaveLength(1),
  );
  f.respondWith(
    async () => `response:{"channel_id":"${canonical}","created":false}`,
  );
  await expect(
    f.owner.session.directMessages.open(f.peer.pubkey),
  ).resolves.toBe(canonical);
  expect(f.published.map((event) => event.kind)).toEqual([41010]);
});

it("waits for roster metadata before returning a DM whose roster arrived first", async () => {
  const f = relayFixture();
  f.dm(canonical);
  const release = f.holdMetadata();
  f.owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(f.owner.session.channels.list().channels).toHaveLength(1),
  );
  expect(f.owner.session.channels.list().channels[0]?.channelType).toBe(
    undefined,
  );
  f.respondWith(
    async () => `response:{"channel_id":"${canonical}","created":false}`,
  );
  const opening = f.owner.session.directMessages.open(f.peer.pubkey);
  let settled = false;
  void opening.finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(f.published).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  release();
  await expect(opening).resolves.toBe(canonical);
  expect(f.published).toHaveLength(1);
});

it("returns the destination when journal cleanup cannot persist", async () => {
  const f = relayFixture();
  f.respondWith(async () => {
    f.dm(canonical);
    f.failSaves(true);
    return `response:{"channel_id":"${canonical}","created":true}`;
  });
  await expect(
    f.owner.session.directMessages.open(f.peer.pubkey),
  ).resolves.toBe(canonical);
});

it("shares one command between concurrent opens for the same peer", async () => {
  const f = relayFixture();
  let release = () => {};
  f.respondWith(
    () =>
      new Promise((resolve) => {
        release = () => {
          f.dm(canonical);
          resolve(`response:{"channel_id":"${canonical}","created":true}`);
        };
      }),
  );
  const first = f.owner.session.directMessages.open(f.peer.pubkey);
  const second = f.owner.session.directMessages.open(f.peer.pubkey);
  expect(second).toBe(first);
  await vi.waitFor(() => expect(f.published).toHaveLength(1));
  release();
  await expect(first).resolves.toBe(canonical);
  expect(f.published).toHaveLength(1);
});

it("reports a rejected open and retries with a fresh command", async () => {
  const f = relayFixture();
  f.respondWith(async () => {
    throw new PublishRejected("restricted: not allowed");
  });
  await expect(
    f.owner.session.directMessages.open(f.peer.pubkey),
  ).rejects.toThrow("could not be started");
  await vi.waitFor(() => expect(f.records()).toEqual([]));
  f.respondWith(async () => {
    f.dm(canonical);
    return `response:{"channel_id":"${canonical}","created":true}`;
  });
  await expect(
    f.owner.session.directMessages.open(f.peer.pubkey),
  ).resolves.toBe(canonical);
  expect(f.published).toHaveLength(2);
  expect(f.published[0]?.id).not.toBe(f.published[1]?.id);
});

it("never navigates on an unknown or malformed receipt; retry reopens", async () => {
  for (const outcome of ["unknown", "malformed", "mismatched"] as const) {
    const f = relayFixture();
    f.respondWith(async () => {
      f.dm(canonical); // The relay may have acted before the receipt was lost.
      if (outcome === "unknown") throw new Error("socket closed");
      return outcome === "malformed"
        ? "response:{not json"
        : `response:{"channel_id":"${canonical}x"}`;
    });
    await expect(
      f.owner.session.directMessages.open(f.peer.pubkey),
    ).rejects.toThrow("could not be confirmed");
    // The retained intent is unknown; the retry's idempotent open resolves it.
    f.respondWith(
      async () => `response:{"channel_id":"${canonical}","created":false}`,
    );
    await expect(
      f.owner.session.directMessages.open(f.peer.pubkey),
    ).resolves.toBe(canonical);
    expect(f.published).toHaveLength(2);
    await vi.waitFor(() => expect(f.records()).toEqual([]));
  }
});

it("waits for roster propagation before returning the destination", async () => {
  const f = relayFixture();
  // Accepted, but the roster has not propagated yet.
  f.respondWith(
    async () => `response:{"channel_id":"${canonical}","created":true}`,
  );
  const opening = f.owner.session.directMessages.open(f.peer.pubkey);
  let settled = false;
  void opening.finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(f.published).toHaveLength(1));
  // Barrier: the readback completed without the DM.
  await vi.waitFor(() =>
    expect(f.owner.session.channels.list().status).toBe("ready"),
  );
  expect(f.owner.session.channels.list().channels).toEqual([]);
  expect(settled).toBe(false);
  f.dm(canonical);
  f.owner.session.channels.refreshList?.(); // A later membership hint.
  await expect(opening).resolves.toBe(canonical);
});

it("replaces a restored unconfirmed intent instead of guessing its destination", async () => {
  const viewer = keypair();
  const peerKey = keypair();
  const intent = signed(viewer, {
    kind: 41010,
    content: "",
    tags: [
      ["p", peerKey.pubkey],
      ["d", other],
    ],
  });
  const f = relayFixture(
    [{ event: intent, signed: intent, delivery: "unknown" }],
    viewer,
    peerKey,
  );
  await vi.waitFor(() =>
    expect(f.owner.session.outbox?.snapshot()).toHaveLength(1),
  );
  f.respondWith(async () => {
    f.dm(canonical);
    return `response:{"channel_id":"${canonical}","created":false}`;
  });
  await expect(
    f.owner.session.directMessages.open(f.peer.pubkey),
  ).resolves.toBe(canonical);
  expect(f.published.map((event) => event.id)).not.toContain(intent.id);
});

it("cancels an open when the session changes", async () => {
  const f = relayFixture();
  f.respondWith(() => new Promise(() => {}));
  const opening = f.owner.session.directMessages.open(f.peer.pubkey);
  await vi.waitFor(() => expect(f.published).toHaveLength(1));
  f.owner.dispose();
  await expect(opening).rejects.toThrow("connection changed");
});

it("rejects without publishing when the session changes during journal cleanup", async () => {
  const viewer = keypair();
  const peerKey = keypair();
  const intent = signed(viewer, {
    kind: 41010,
    content: "",
    tags: [
      ["p", peerKey.pubkey],
      ["d", other],
    ],
  });
  const f = relayFixture(
    [{ event: intent, signed: intent, delivery: "unknown" }],
    viewer,
    peerKey,
  );
  f.dm(canonical);
  f.owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(f.owner.session.channels.list().channels).toHaveLength(1),
  );
  await vi.waitFor(() =>
    expect(f.owner.session.outbox?.snapshot()).toHaveLength(1),
  );
  const release = f.holdSaves();
  try {
    const opening = f.owner.session.directMessages.open(f.peer.pubkey);
    // Barrier: dismissal removed the intent and is waiting on the held save.
    await vi.waitFor(() =>
      expect(f.owner.session.outbox?.snapshot()).toHaveLength(0),
    );
    f.owner.dispose();
    await expect(opening).rejects.toThrow("connection changed");
  } finally {
    release();
  }
  expect(f.published).toHaveLength(0);
});

it("reports a session change that lands just before publishing as cancellation", async () => {
  const controller = new AbortController();
  let sent = 0;
  const outbox = {
    supports: () => true,
    snapshot: () => [],
    subscribe: () => () => {},
    observeSend: () => () => {},
    retry: () => {},
    dismiss: async () => {},
    send() {
      // Mirrors the outbox closed guard.
      if (controller.signal.aborted)
        throw new DOMException("Relay session closed", "AbortError");
      sent++;
      return "sent";
    },
  };
  const dms = createDirectMessages(
    outbox,
    queries({ status: "ready", channels: [] }),
    "a".repeat(64),
    controller.signal,
  );
  const opening = dms.capability.open("b".repeat(64));
  // Disposal runs after the readiness wait settles, before publishing resumes.
  queueMicrotask(() => controller.abort());
  await expect(opening).rejects.toThrow("connection changed");
  expect(sent).toBe(0);
});

function queries(initial: ChannelList): ChannelQueries & {
  set(next: ChannelList): void;
} {
  let list = initial;
  const listeners = new Set<() => void>();
  return {
    list: () => list,
    subscribeList: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      list = next;
      for (const listener of listeners) listener();
    },
    window: () => {
      throw new Error("unused");
    },
    subscribeWindow: () => () => {},
    ensureList: () => {},
    ensure: () => {},
    loadOlder: () => {},
    refreshList: () => {},
  };
}

it("rejects self, malformed keys and wrong-scope rosters", async () => {
  vi.useFakeTimers();
  try {
    const viewer = "a".repeat(64),
      peer = "b".repeat(64),
      third = "c".repeat(64);
    const sent: string[] = [];
    const receipts: ((message: string) => void)[] = [];
    let items: OutgoingEvent[] = [];
    const listeners = new Set<() => void>();
    const outbox = {
      supports: () => true,
      snapshot: () => items,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      observeSend: () => () => {},
      retry: () => {},
      dismiss: async (id: string) => {
        items = items.filter((item) => item.event.id !== id);
      },
      send(input: Pick<EventTemplate, "kind" | "content" | "tags">) {
        const event = {
          ...input,
          id: `${sent.length}`,
          pubkey: viewer,
          created_at: 1,
        };
        sent.push(event.id);
        items = [...items, { event, delivery: "sending" }];
        receipts.push((message) => {
          dms.receipt(event, message);
          items = items.map((item) =>
            item.event.id === event.id
              ? { ...item, delivery: "accepted" }
              : item,
          );
          for (const listener of listeners) listener();
        });
        return event.id;
      },
    };
    const wrongScope = [
      {
        id: other,
        name: "",
        channelType: "dm",
        members: [viewer, peer, third],
      },
      {
        id: canonical,
        name: "",
        channelType: "stream",
        members: [viewer, peer],
      },
    ] as const;
    const channels = queries({ status: "ready", channels: wrongScope });
    const dms = createDirectMessages(
      outbox,
      channels,
      viewer,
      new AbortController().signal,
      Promise.resolve(),
      1000,
    );
    await expect(dms.capability.open(viewer)).rejects.toThrow("another person");
    await expect(dms.capability.open("B".repeat(64))).rejects.toThrow(
      "another person",
    );
    // A group DM and a stream with the same members are not this DM.
    const opening = dms.capability.open(peer);
    const failed = expect(opening).rejects.toThrow("still loading");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    receipts[0]?.(`response:{"channel_id":"${canonical}","created":false}`);
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    // Missing roster: an error snapshot never becomes a destination.
    const next = dms.capability.open(peer);
    const missing = expect(next).rejects.toThrow("roster down");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    receipts[1]?.(`response:{"channel_id":"${canonical}","created":false}`);
    // Barrier: journal cleanup finished and roster readback is subscribed.
    await vi.waitFor(() => expect(items).toEqual([]));
    await vi.advanceTimersByTimeAsync(0);
    channels.set({ status: "error", channels: [], error: "roster down" });
    await missing;
  } finally {
    vi.useRealTimers();
  }
});
