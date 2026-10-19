import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { withdraw } from "../solo/withdraw";
import { subscribeRelayTraffic } from "./live";
import { keypair, metadata, roster, signed } from "./testing";
import { matchesEvent } from "./projection";
import { SOLO_LABEL } from "../solo/labels";
import type { EventTemplate } from "nostr-tools";
import type { ReadFilter, RelayEvent } from "./events";

class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  requests() {
    return this.sent.filter((e) => e[0] === "REQ");
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((e) => e[0] === "AUTH")?.[1];
    await this.receive(["OK", (event as RelayEvent).id, true]);
  }
}
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

/** A relay that makes the chat, with the members its create names, once it
 * accepts the create; `release` lets the held create through. `refuse` makes
 * it reject the create instead. */
function setup(id: string, deliveryTimeoutMs?: number) {
  vi.useFakeTimers();
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  let created: string[] | undefined;
  let release = () => {};
  let refuse = false;
  let loseAck = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    [
      roster(relay, "c", [viewer.pubkey]),
      metadata(relay, "c", "General"),
      ...(created
        ? [
            roster(relay, id, created),
            metadata(relay, id, "Start", 1_700_000_000, [
              ["t", "stream"],
              ["private"],
              ["t", SOLO_LABEL],
            ]),
          ]
        : []),
    ].filter((e) => filters.some((f) => matchesEvent(e, f))),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind !== 9007) return;
    await held;
    if (refuse) throw new PublishRejected("blocked: not allowed");
    created = [
      event.pubkey,
      ...event.tags.flatMap(([name, key]) =>
        name === "p" && key ? [key] : [],
      ),
    ];
    if (loseAck) {
      loseAck = false;
      throw new Error("ACK connection lost");
    }
  });
  const sockets: Socket[] = [];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      channelIdentity: true,
      media: (url) => url,
      query,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish,
      },
      subscribe(callbacks) {
        return subscribeRelayTraffic(
          "wss://fixture.invalid",
          async (t) => signed(viewer, t),
          viewer.pubkey,
          callbacks,
          () => {
            const socket = new Socket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        );
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      ...(deliveryTimeoutMs ? { deliveryTimeoutMs } : {}),
    },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  return {
    ...owner,
    agent,
    publish,
    query,
    release,
    refuse() {
      refuse = true;
    },
    loseAck() {
      loseAck = true;
    },
    /** Live subscriptions asked for the chat's events. */
    liveReads(channelId: string) {
      return sockets
        .flatMap((socket) => socket.requests())
        .filter((request) =>
          request
            .slice(2)
            .some((filter) =>
              (filter as ReadFilter)["#h"]?.includes(channelId),
            ),
        ).length;
    },
    async established() {
      await vi.advanceTimersByTimeAsync(0);
      const socket = sockets[0];
      assert.exists(socket);
      await socket.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const request of socket.requests())
        await socket.receive(["EOSE", request[1]]);
      await vi.advanceTimersByTimeAsync(1);
    },
  };
}

it("a new chat's first message reaches its local agent at once and the relay right after the create", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const h = setup(id);
  await h.established();
  const heard: RelayEvent[] = [];
  h.session.subscribeLive((batch) => heard.push(...batch.events), {
    replay: true,
  });
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  const listed = () =>
    h.session.channels.list().channels.find((channel) => channel.id === id);
  expect(listed()).toMatchObject({
    channelType: "solo",
    pending: true,
    members: expect.arrayContaining([h.agent.pubkey]),
  });
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  h.session.channels.ensure(id);
  await vi.advanceTimersByTimeAsync(0);
  // The open chat shows the message from here, with no history to read yet.
  const window = () => h.session.channels.window(id);
  const historyReads = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter["#h"]?.includes(id)),
    ).length;
  expect(window().status).toBe("ready");
  expect(window().rows.map((row) => row.id)).toEqual([message]);
  expect(historyReads()).toBe(0);
  // Only the create is on its way; the agent already has the message.
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([9007]);
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual([
    "p",
    h.agent.pubkey,
  ]);
  expect(heard.map((event) => event.id)).toEqual([message]);
  // Nor does its live tail, which the relay refuses until the chat exists.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.liveReads(id)).toBe(0);

  let settled = false;
  void ready.then(() => {
    settled = true;
  });
  h.release();
  for (let step = 0; step < 40 && !settled; step++)
    await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([9007, 9]);
  expect(h.publish.mock.calls[1]?.[0].id).toBe(message);
  expect(listed()?.pending).toBeUndefined();
  // Once the relay has it, the open chat reads its history.
  await vi.advanceTimersByTimeAsync(0);
  expect(historyReads()).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.liveReads(id)).toBeGreaterThan(0);
  expect(listed()?.members).toContain(h.agent.pubkey);
});

it("a refused create drops the pending chat and never publishes its message", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const h = setup(id);
  await h.established();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  ready.catch(() => {});
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  const outbox = h.session.outbox;
  assert.exists(outbox);
  // As the new-chat composer does: withdraw as soon as the start fails, while
  // the message's attempt may still be waiting on it.
  const withdrawn = ready.then(
    () => {},
    () => withdraw(outbox, message),
  );
  h.refuse();
  h.release();
  await vi.advanceTimersByTimeAsync(0);
  await expect(ready).rejects.toThrow("blocked");
  await vi.advanceTimersByTimeAsync(0);
  await withdrawn;
  expect(outbox.snapshot().map((item) => item.event.id)).not.toContain(message);
  // The create was sent, and once more on retry; never the message.
  expect(new Set(h.publish.mock.calls.map(([event]) => event.kind))).toEqual(
    new Set([9007]),
  );
  expect(
    h.session.channels.list().channels.some((channel) => channel.id === id),
  ).toBe(false);
});

async function settle(ready: Promise<void>) {
  let settled = false;
  void ready.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let step = 0; step < 400 && !settled; step++)
    await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
}

it("a lost create acknowledgment resends the same create, and the chat starts", async () => {
  const id = "77777777-7777-4777-8777-777777777777";
  const h = setup(id);
  await h.established();
  h.loseAck();
  const { create, ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  h.release();
  await settle(ready);
  await expect(ready).resolves.toBeUndefined();
  const sent = h.publish.mock.calls.map(([event]) => event.id);
  expect(sent.filter((event) => event === create).length).toBeGreaterThan(0);
  expect(sent.at(-1)).toBe(message);
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === id)
      ?.pending,
  ).toBeUndefined();
});

it("a message that times out while its chat starts goes once the chat exists", async () => {
  const id = "88888888-8888-4888-8888-888888888888";
  const h = setup(id, 2_000);
  await h.established();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  ready.catch(() => {});
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(2_500);
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === message)
      ?.delivery,
  ).toBe("failed");
  h.release();
  await settle(ready);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish.mock.calls.at(-1)?.[0].id).toBe(message);
});
