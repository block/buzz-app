import { afterEach, expect, it, vi } from "vitest";
import {
  BANNED,
  type ChannelAccess,
  type ChannelAccessAnswer,
} from "./channel-access";
import { ReadError } from "./errors";
import { type LiveCallbacks, subscribeRelayTraffic } from "./live";
import { createRelaySession } from "./session";
import type { RelayEvent } from "./events";
import { PublishRejected } from "./outbox";
import {
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(frame: unknown[]) {
    await this.onmessage?.({ data: JSON.stringify(frame) });
  }
  requests() {
    return this.sent.filter(([type]) => type === "REQ") as [
      string,
      string,
      { kinds: number[]; "#h"?: string[] },
    ][];
  }
}

afterEach(() => vi.useRealTimers());
const settle = () => vi.advanceTimersByTimeAsync(0);
const conversation = "00000000-0000-8000-8000-00000000000c";
const member: ChannelAccess = { post: true, joined: false, role: "member" };
const guest: ChannelAccess = { post: false, joined: false, role: "guest" };

type Ask = {
  ids: readonly string[];
  answer(access?: ChannelAccess): void;
  fail(error: unknown): void;
};

/** A session joined to "a", with the relay's access answer scripted. */
async function setup() {
  vi.useFakeTimers();
  const viewer = keypair();
  const relay = keypair();
  let socket = new Socket();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const asks: Ask[] = [];
  let live!: LiveCallbacks;
  const publishes: Array<{
    event: RelayEvent;
    accept(): void;
    refuse(error: unknown): void;
  }> = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (event) => signed(viewer, event),
        publish: (event) =>
          new Promise<void>((accept, refuse) => {
            publishes.push({ event, accept, refuse });
          }),
      },
      channelAccess: (ids) =>
        new Promise<ChannelAccessAnswer>((resolve, reject) => {
          asks.push({
            ids,
            answer: (access) =>
              resolve(new Map(access ? [[conversation, access]] : [])),
            fail: reject,
          });
        }),
      subscribe(callbacks) {
        live = callbacks;
        return subscribeRelayTraffic(
          "wss://relay.test",
          async (event) => signed(viewer, event),
          viewer.pubkey,
          callbacks,
          () => {
            socket = new Socket();
            return socket as unknown as WebSocket;
          },
        );
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
    },
  );
  const connect = async () => {
    await socket.receive(["AUTH", "challenge"]);
    const auth = socket.sent.find(([type]) => type === "AUTH")?.[1] as {
      id: string;
    };
    await socket.receive(["OK", auth.id, true]);
    for (const [, id] of socket.requests()) await socket.receive(["EOSE", id]);
    await settle();
  };
  await connect();
  wire.next().respond([roster(relay, "a", [viewer.pubkey])]);
  await settle();
  wire.next().respond([metadata(relay, "a", "Alpha")]);
  await settle();
  for (const [, id, filter] of socket.requests())
    if (filter["#h"]) await socket.receive(["EOSE", id]);
  await settle();
  const comments = metadata(relay, conversation, "Comments", 1_700_000_000, [
    ["private"],
    ["t", "artifact"],
    ["parent", "a"],
  ]);
  const ask = async () => {
    await settle();
    const next = asks.shift();
    if (!next) throw new Error("The relay was not asked");
    expect(next.ids).toEqual([conversation]);
    return next;
  };
  /** Answers the pending reads `matches` selects, in order. */
  const answer = (
    matches: (filters: readonly Record<string, unknown>[]) => boolean,
    events: Parameters<(typeof wire.pending)[number]["respond"]>[0],
  ) => {
    const found = wire.pending.filter((read) =>
      matches(read.filters as readonly Record<string, unknown>[]),
    );
    for (const read of found) {
      wire.pending.splice(wire.pending.indexOf(read), 1);
      read.respond(events);
    }
    return found.length;
  };
  /** The named metadata read that follows a grant. */
  const named = async () => {
    await settle();
    expect(
      answer(
        ([filter]) =>
          JSON.stringify(filter?.kinds) === "[39000]" &&
          JSON.stringify(filter?.["#d"]) === JSON.stringify([conversation]),
        [comments],
      ),
    ).toBe(1);
    await settle();
  };
  const route = () =>
    socket
      .requests()
      .filter(([, , filter]) => filter["#h"]?.includes(conversation))
      .at(-1);
  /** Opens the conversation's window and its live route. */
  const open = async () => {
    owner.session.channels.ensure(conversation);
    // The live route and the window's reads follow one another; answer each
    // as it is asked.
    const established = new Set<string>();
    let answered = 0;
    for (let turn = 0; turn < 6; turn++) {
      await vi.advanceTimersByTimeAsync(100);
      const subscription = route();
      if (subscription && !established.has(subscription[1])) {
        expect(subscription[2].kinds).toContain(20004);
        established.add(subscription[1]);
        await socket.receive(["EOSE", subscription[1]]);
      }
      answered += answer(
        (filters) => JSON.stringify(filters).includes(conversation),
        [
          message(viewer, conversation, "First comment", 1_700_000_100),
          signed(relay, {
            kind: 39006,
            content: JSON.stringify({ has_more: false, next_cursor: null }),
            created_at: 1_700_000_100,
            tags: [
              ["d", `${conversation}:head`],
              ["h", conversation],
            ],
          }),
        ],
      );
    }
    expect(established.size).toBe(1);
    expect(answered).toBeGreaterThan(0);
    await settle();
  };
  const hint = async () => {
    const subscription = route();
    await socket.receive([
      "EVENT",
      subscription?.[1],
      signed(relay, {
        kind: 20004,
        content: "",
        created_at: 1_700_000_200,
        tags: [["h", conversation]],
      }),
    ]);
  };
  /** The relay's "ask again" about the viewer's own access. */
  const personal = async () => {
    const subscription = socket
      .requests()
      .filter((request) =>
        (request.slice(2) as { kinds: number[] }[]).some((filter) =>
          filter.kinds.includes(20005),
        ),
      )
      .at(-1);
    expect(subscription).toBeDefined();
    await socket.receive([
      "EVENT",
      subscription?.[1],
      signed(relay, {
        kind: 20005,
        content: "",
        created_at: 1_700_000_300,
        tags: [["p", viewer.pubkey]],
      }),
    ]);
  };
  const rows = () =>
    owner.session.channels
      .window(conversation)
      .rows.flatMap((row) => ("content" in row ? [row.content] : []));
  return {
    viewer,
    relay,
    owner,
    wire,
    asks,
    ask,
    named,
    open,
    hint,
    personal,
    rows,
    answer,
    publishes,
    route,
    socket: () => socket,
    connect,
    live: () => live,
  };
}

it("opens an unjoined conversation through the relay's answer, never listing it", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    expect(handle?.snapshot()).toEqual({ status: "loading" });
    (await h.ask()).answer(member);
    await h.named();
    expect(handle?.snapshot()).toEqual({
      status: "open",
      post: true,
      joined: false,
    });
    expect(h.owner.session.channels.get?.(conversation)).toMatchObject({
      channelType: "artifact",
      viewerRole: "member",
    });
    expect(
      h.owner.session.channels.list().channels.map(({ id }) => id),
    ).toEqual(["a"]);
    await h.open();
    expect(h.rows()).toEqual(["First comment"]);
    handle?.release();
    await settle();
    expect(h.owner.session.channels.get?.(conversation)).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});

it("refuses a conversation the relay leaves out, and grants nothing for its address", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer();
    await settle();
    expect(handle?.snapshot()).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(h.owner.session.channels.get?.(conversation)).toBeUndefined();
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("loses and regains posting on the relay's hint while reading continues", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    await h.hint();
    (await h.ask()).answer(guest);
    await h.named();
    expect(handle?.snapshot()).toEqual({
      status: "open",
      post: false,
      joined: false,
    });
    expect(h.owner.session.channels.get?.(conversation)?.readOnly).toBe(true);
    expect(h.rows()).toEqual(["First comment"]);
    await h.hint();
    (await h.ask()).answer(member);
    await h.named();
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: true });
    expect(
      h.owner.session.channels.get?.(conversation)?.readOnly,
    ).toBeUndefined();
    expect(h.rows()).toEqual(["First comment"]);
  } finally {
    h.owner.dispose();
  }
});

it("waits, hidden, when a revoked live route's recheck fails, and never treats it as revocation", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    await h
      .socket()
      .receive([
        "CLOSED",
        h.route()?.[1],
        "restricted: channel access revoked",
      ]);
    await settle();
    // Hidden while the relay is asked again.
    expect(h.owner.session.channels.get?.(conversation)).toBeUndefined();
    (await h.ask()).fail(new TypeError("Failed to fetch"));
    await settle();
    expect(handle?.snapshot()).toEqual({
      status: "unavailable",
      reason: "failed",
    });
    handle?.retry();
    (await h.ask()).answer(member);
    await h.named();
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: true });
  } finally {
    h.owner.dispose();
  }
});

it("asks again after the live connection drops, and closes on a confirmed loss", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    h.socket().close();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.connect();
    await settle();
    (await h.ask()).answer();
    await settle();
    expect(handle?.snapshot()).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(h.owner.session.channels.get?.(conversation)).toBeUndefined();
    expect(h.owner.session.channels.window(conversation).rows).toEqual([]);
  } finally {
    h.owner.dispose();
  }
});

it("drops a pending check when access is lost before it answers", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    const pending = await h.ask();
    handle?.release();
    pending.answer(member);
    await settle();
    expect(h.owner.session.channels.get?.(conversation)).toBeUndefined();
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("asks the relay again when it refuses a post, and keeps reading", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    h.owner.session.messages.send(conversation, "Second comment");
    await vi.waitFor(() => expect(h.publishes).toHaveLength(1));
    h.publishes
      .shift()
      ?.refuse(
        new PublishRejected("Not allowed", "restricted: view-only access"),
      );
    (await h.ask()).answer(guest);
    await h.named();
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: false });
    expect(h.rows()).toContain("First comment");
    // Posting is unavailable here now; the app refuses before the relay.
    expect(() =>
      h.owner.session.messages.send(conversation, "Third comment"),
    ).toThrow();
  } finally {
    h.owner.dispose();
  }
});

it("stops a pending send when access is lost while it is in flight", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    h.owner.session.messages.send(conversation, "Second comment");
    await vi.waitFor(() => expect(h.publishes).toHaveLength(1));
    await h.hint();
    (await h.ask()).answer();
    await settle();
    expect(handle?.snapshot()).toMatchObject({ status: "unavailable" });
    h.publishes
      .shift()
      ?.refuse(new PublishRejected("Not allowed", "restricted: no access"));
    await settle();
    // Stopped, never retried, and its text kept for the person to copy.
    await vi.advanceTimersByTimeAsync(60_000);
    const stopped = h.owner.session.outbox
      ?.snapshot()
      .filter((item) =>
        item.event.tags.some(([, value]) => value === conversation),
      );
    expect(stopped).toMatchObject([
      { delivery: "failed", event: { content: "Second comment" } },
    ]);
    expect(h.publishes).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it("shows nothing from a read that lands after access is lost", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    h.owner.session.channels.ensure(conversation);
    await vi.advanceTimersByTimeAsync(100);
    const pending = h.wire.pending.filter((read) =>
      JSON.stringify(read.filters).includes(conversation),
    );
    expect(pending.length).toBeGreaterThan(0);
    handle?.retry();
    (await h.ask()).answer();
    await settle();
    expect(handle?.snapshot()).toMatchObject({ status: "unavailable" });
    h.answer(
      (filters) => JSON.stringify(filters).includes(conversation),
      [message(h.viewer, conversation, "Late comment", 1_700_000_300)],
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(h.rows()).toEqual([]);
    expect(h.owner.session.channels.get?.(conversation)).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});

it("keeps a refused post's text when the recheck confirms access is gone", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    h.owner.session.messages.send(conversation, "Second comment");
    await vi.waitFor(() => expect(h.publishes).toHaveLength(1));
    h.publishes
      .shift()
      ?.refuse(new PublishRejected("Not allowed", "restricted: no access"));
    (await h.ask()).answer();
    await settle();
    expect(handle?.snapshot()).toMatchObject({ status: "unavailable" });
    // The writer confirms the viewer was never listed there.
    await vi.waitFor(() =>
      expect(
        h.answer((filters) => {
          const text = JSON.stringify(filters);
          return text.includes("39002") && text.includes(conversation);
        }, []),
      ).toBeGreaterThan(0),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      h.owner.session.outbox
        ?.snapshot()
        .filter((item) =>
          item.event.tags.some(([, value]) => value === conversation),
        ),
    ).toMatchObject([
      { delivery: "failed", event: { content: "Second comment" } },
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("stays hidden after a failed recheck until the relay itself answers", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    await h.hint();
    (await h.ask()).fail(new TypeError("Failed to fetch"));
    await settle();
    expect(handle?.snapshot()).toMatchObject({ reason: "failed" });
    // Fresh metadata is not the relay's answer about this viewer.
    void h.owner.session.channels.resolve?.([conversation]);
    await h.named();
    expect(h.owner.session.channels.get?.(conversation)).toBeUndefined();
    expect(() =>
      h.owner.session.messages.send(conversation, "Too soon"),
    ).toThrow();
  } finally {
    h.owner.dispose();
  }
});

const timedOut = (until: number): ChannelAccess => ({
  post: false,
  joined: false,
  role: "member",
  until,
});

it("gives posting back when a timeout ends, with no push", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(timedOut(Math.floor(Date.now() / 1000) + 60));
    await h.named();
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: false });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.asks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    (await h.ask()).answer(member);
    await h.named();
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: true });
  } finally {
    h.owner.dispose();
  }
});

it("asks again about every held conversation when the viewer's own access changes", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).answer(member);
    await h.named();
    await h.open();
    // A timeout starts.
    await h.personal();
    (await h.ask()).answer(timedOut(Math.floor(Date.now() / 1000) + 3600));
    await h.named();
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: false });
    // It is lifted early.
    await h.personal();
    (await h.ask()).answer(member);
    await h.named();
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: true });
    expect(h.rows()).toEqual(["First comment"]);
  } finally {
    h.owner.dispose();
  }
});

it("says a banned viewer is banned, not that the check failed", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    (await h.ask()).fail(new ReadError("denied", BANNED, 403));
    await settle();
    expect(handle?.snapshot()).toEqual({
      status: "unavailable",
      reason: "banned",
    });
  } finally {
    h.owner.dispose();
  }
});

it("asks a handful of times, not in a burst, when this clock runs two minutes fast", async () => {
  const h = await setup();
  try {
    const handle = h.owner.session.channels.reach?.(conversation);
    // The relay's clock is two minutes behind this one, and the timeout ends
    // two minutes from now by the relay's: "now" here.
    const ends = Math.floor(Date.now() / 1000);
    const relayLifts = Date.now() + 120_000;
    const reply = () => (Date.now() < relayLifts ? timedOut(ends) : member);
    (await h.ask()).answer(reply());
    await h.named();
    let asked = 1;
    for (let second = 0; second < 300; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      while (h.asks.length) {
        h.asks.shift()?.answer(reply());
        asked++;
        await h.named();
      }
    }
    expect(asked).toBeLessThanOrEqual(8);
    expect(handle?.snapshot()).toMatchObject({ status: "open", post: true });
  } finally {
    h.owner.dispose();
  }
});
