import { assert, expect, it, vi } from "vitest";
import { foldMessages } from "./fold";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import type { HeadPersistence, SavedHead } from "./persistence";
import { rowProfileIds } from "./membership";

const relay = keypair(),
  viewer = keypair(),
  pinky = keypair(),
  brain = keypair();
const activity = (body: unknown, time = 20, signer = relay, channel = "a") =>
  signed(signer, {
    kind: 40099,
    content: JSON.stringify(body),
    created_at: time,
    tags: [["h", channel]],
  });
const addition = (target = pinky.pubkey, time = 20) =>
  activity({ type: "member_joined", actor: viewer.pubkey, target }, time);
const end = () =>
  bounds(relay, "a", "head", { has_more: false, next_cursor: null });

it("admits only recognized, channel-scoped relay-authored membership payloads", () => {
  const joined = addition();
  const left = activity({ type: "member_left", actor: pinky.pubkey });
  const removed = activity({
    type: "member_removed",
    actor: viewer.pubkey,
    target: brain.pubkey,
  });
  const rows = foldMessages("a", relay.pubkey, [joined, left, removed]);
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.id === left.id)?.membership?.target).toBe(
    pinky.pubkey,
  );
  expect(
    rows.every((r) => !r.content && !r.mentions.length && !r.replyCount),
  ).toBe(true);
  const joinedRow = rows.find((r) => r.id === joined.id);
  assert.exists(joinedRow);
  expect(rowProfileIds(joinedRow)).toEqual([viewer.pubkey, pinky.pubkey]);
  const invalid = [
    null,
    [],
    {},
    { type: "channel_created", actor: viewer.pubkey },
    { type: "member_joined", actor: viewer.pubkey },
    { type: "member_joined", actor: "fake", target: pinky.pubkey },
    { type: "member_removed", actor: viewer.pubkey, target: "fake" },
    { type: "member_left", actor: pinky.pubkey, target: brain.pubkey },
  ];
  expect(
    foldMessages("a", relay.pubkey, [
      ...invalid.map((body) => activity(body)),
      activity(
        { type: "member_joined", actor: viewer.pubkey, target: pinky.pubkey },
        20,
        viewer,
      ),
      activity(
        { type: "member_left", actor: pinky.pubkey },
        20,
        relay,
        "other",
      ),
      signed(relay, {
        kind: 40099,
        content: "broken JSON",
        tags: [["h", "a"]],
      }),
    ]),
  ).toEqual([]);
});

it.each([false, true])(
  "history, live, older pages and optional profiles share the existing session (prepared=%s)",
  async (prepared) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { prepared },
    );
    const q = owner.session.channels;
    try {
      q.ensureList();
      wire
        .next()
        .respond([
          roster(relay, "a", [viewer.pubkey]),
          metadata(relay, "a", "A"),
        ]);
      await flush();
      q.ensure("a");
      const head = wire.next();
      expect([...(head.filters[0]?.kinds ?? [])].sort((a, b) => a - b)).toEqual(
        [9, 40002, 40008, 40099, 48100, 48103],
      );
      const row = addition();
      head.respond([
        row,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: { created_at: row.created_at, id: row.id },
        }),
      ]);
      await flush();
      // A head of only activity reads on to a conversational row or the start.
      const older = wire.next();
      expect(older.filters[0]).toMatchObject({
        kinds: [40002, 40008, 40099, 48100, 48103, 9],
        until: 20,
        before_id: row.id,
        limit: 200,
      });
      const old = addition(pinky.pubkey, 19);
      older.respond([
        old,
        bounds(relay, "a", `20:${row.id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]);
      await flush();
      expect(q.window("a")).toMatchObject({ status: "ready", hasMore: false });
      expect(q.window("a").rows.map((r) => r.id)).toEqual([old.id, row.id]);
      // Render before enrichment, with no per-row blocking request.
      const names = wire.next();
      expect([...(names.filters[0]?.authors ?? [])].sort()).toEqual(
        [viewer.pubkey, pinky.pubkey].sort(),
      );
      names.respond([
        profile(viewer, { name: "Wes" }),
        profile(pinky, { name: "Pinky" }),
      ]);
      await flush();
      const chat = message(pinky, "a", "Conversation preview", 21);
      live.receive([chat, addition(brain.pubkey, 22)]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([
        old.id,
        row.id,
        chat.id,
        addition(brain.pubkey, 22).id,
      ]);
      expect(q.list().channels[0]?.preview).toBe("Conversation preview");
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "a" })
          .observedCount,
      ).toBe(1);
      const moreNames = wire.next();
      expect(moreNames.filters[0]?.authors).toEqual([brain.pubkey]);
      moreNames.respond([profile(brain, { name: "Brain" })]);
      await flush();
      const before = q.window("a").rows;
      live.receive([
        activity(
          { type: "member_joined", actor: viewer.pubkey, target: brain.pubkey },
          23,
          pinky,
        ),
      ]);
      expect(q.window("a").rows).toEqual(before);
      live.receive([roster(relay, "a", [], 1_800_000_000)]);
      expect(q.window("a").rows).toEqual([]);
    } finally {
      owner.dispose();
    }
  },
);

/** The next channel-window read the session issues for `channel`. */
const windowRead = (
  wire: ReturnType<typeof scriptedTransport>,
  channel = "a",
) =>
  vi.waitFor(() => {
    const index = wire.pending.findIndex(
      (entry) =>
        entry.filters[0]?.top_level && entry.filters[0]["#h"]?.[0] === channel,
    );
    const [entry] = index < 0 ? [] : wire.pending.splice(index, 1);
    assert.exists(entry);
    return entry;
  });
const windowReads = (wire: ReturnType<typeof scriptedTransport>) =>
  wire.pending.filter((entry) => entry.filters[0]?.top_level).length;
const after = (event: RelayEvent) => `${event.created_at}:${event.id}`;
const cursorAt = (event: RelayEvent) => ({
  created_at: event.created_at,
  id: event.id,
});
const last = (events: readonly RelayEvent[]) => {
  const event = events.at(-1);
  assert.exists(event);
  return event;
};

it.each([false, true])(
  "a head of hundreds of joins reads on to a page of conversation, then pages normally (prepared=%s)",
  async (prepared) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { prepared },
    );
    const q = owner.session.channels;
    try {
      live.receive([roster(relay, "a", [viewer.pubkey])]);
      const joins = Array.from({ length: 320 }, (_, index) =>
        addition(pinky.pubkey, 1000 - index),
      );
      const newest = joins.slice(0, 20),
        middle = joins.slice(20, 220),
        rest = joins.slice(220);
      const conversation = Array.from({ length: 25 }, (_, index) =>
        message(brain, "a", `Conversation ${index}`, 500 - index),
      );
      const reached = conversation.slice(0, 5),
        filled = conversation.slice(5);
      const oldest = message(brain, "a", "Oldest", 400),
        arrival = message(brain, "a", "Arrived meanwhile", 2000);
      q.ensure("a");
      const head = await windowRead(wire);
      expect(head.filters[0]).toMatchObject({ limit: 20 });
      expect(head.filters[0]).not.toHaveProperty("until");
      head.respond([
        ...newest,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: cursorAt(last(newest)),
        }),
      ]);
      const second = await windowRead(wire);
      expect(second.filters[0]).toMatchObject({
        until: 981,
        before_id: last(newest).id,
        limit: 200,
      });
      expect(q.window("a").status).toBe("loading");
      live.receive([arrival]);
      second.respond([
        ...middle,
        bounds(relay, "a", after(last(newest)), {
          has_more: true,
          next_cursor: cursorAt(last(middle)),
        }),
      ]);
      const third = await windowRead(wire);
      expect(third.filters[0]).toMatchObject({
        until: 781,
        before_id: last(middle).id,
        limit: 200,
      });
      third.respond([
        ...rest,
        ...reached,
        bounds(relay, "a", after(last(middle)), {
          has_more: true,
          next_cursor: cursorAt(last(reached)),
        }),
      ]);
      // Notices still leave the read short of a page of conversation.
      const fourth = await windowRead(wire);
      expect(fourth.filters[0]).toMatchObject({
        until: 496,
        before_id: last(reached).id,
        limit: 200,
      });
      fourth.respond([
        ...filled,
        bounds(relay, "a", after(last(reached)), {
          has_more: true,
          next_cursor: cursorAt(last(filled)),
        }),
      ]);
      await vi.waitFor(() =>
        expect(q.window("a")).toMatchObject({
          status: "ready",
          hasMore: true,
          loadingOlder: false,
        }),
      );
      const history = [
        ...conversation.map((row) => row.id).reverse(),
        ...joins.map((join) => join.id).reverse(),
        arrival.id,
      ];
      expect(q.window("a").rows.map((row) => row.id)).toEqual(history);
      // The read that filled a page of conversation is complete: nothing else pages.
      expect(windowReads(wire)).toBe(0);
      q.loadOlder("a");
      const older = await windowRead(wire);
      expect(older.filters[0]).toMatchObject({
        until: 476,
        before_id: last(filled).id,
        limit: 20,
      });
      older.respond([
        last(filled),
        oldest,
        bounds(relay, "a", after(last(filled)), {
          has_more: false,
          next_cursor: null,
        }),
      ]);
      await vi.waitFor(() =>
        expect(q.window("a")).toMatchObject({
          hasMore: false,
          loadingOlder: false,
        }),
      );
      expect(q.window("a").rows.map((row) => row.id)).toEqual([
        oldest.id,
        ...history,
      ]);
      expect(windowReads(wire)).toBe(0);
    } finally {
      owner.dispose();
    }
  },
);

it("activity-only history stops at its start or the read bound, and a failed continuation keeps the pages read", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const q = owner.session.channels;
  const joined = (channel: string, time: number) =>
    activity(
      { type: "member_joined", actor: viewer.pubkey, target: pinky.pubkey },
      time,
      relay,
      channel,
    );
  try {
    live.receive([
      roster(relay, "a", [viewer.pubkey]),
      roster(relay, "b", [viewer.pubkey]),
      roster(relay, "c", [viewer.pubkey]),
      roster(relay, "d", [viewer.pubkey]),
    ]);
    // History of only activity ends at its start.
    q.ensure("a");
    const first = joined("a", 30),
      start = joined("a", 29);
    (await windowRead(wire)).respond([
      first,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(first),
      }),
    ]);
    (await windowRead(wire)).respond([
      start,
      bounds(relay, "a", after(first), { has_more: false, next_cursor: null }),
    ]);
    await vi.waitFor(() =>
      expect(q.window("a")).toMatchObject({ status: "ready", hasMore: false }),
    );
    expect(q.window("a").rows.map((row) => row.id)).toEqual([
      start.id,
      first.id,
    ]);
    // An unbroken run stops after the bounded pages, still able to load older.
    q.ensure("b");
    const run = [joined("b", 100)];
    (await windowRead(wire, "b")).respond([
      last(run),
      bounds(relay, "b", "head", {
        has_more: true,
        next_cursor: cursorAt(last(run)),
      }),
    ]);
    for (let page = 1; page <= 5; page++) {
      const read = await windowRead(wire, "b");
      expect(read.filters[0]).toMatchObject({
        before_id: last(run).id,
        limit: 200,
      });
      const notice = joined("b", 100 - page);
      read.respond([
        notice,
        bounds(relay, "b", after(last(run)), {
          has_more: true,
          next_cursor: cursorAt(notice),
        }),
      ]);
      run.push(notice);
    }
    await vi.waitFor(() =>
      expect(q.window("b")).toMatchObject({ status: "ready", hasMore: true }),
    );
    const bounded = run.map((join) => join.id).reverse();
    expect(q.window("b").rows.map((row) => row.id)).toEqual(bounded);
    expect(windowReads(wire)).toBe(0);
    // An older read whose continuation fails keeps the page it read and pages
    // on from that page's bound.
    const notice = joined("b", 90),
      reply = message(brain, "b", "Conversation", 80);
    q.loadOlder("b");
    const older = await windowRead(wire, "b");
    expect(older.filters[0]).toMatchObject({
      before_id: last(run).id,
      limit: 20,
    });
    older.respond([
      notice,
      bounds(relay, "b", after(last(run)), {
        has_more: true,
        next_cursor: cursorAt(notice),
      }),
    ]);
    (await windowRead(wire, "b")).fail(new Error("relay down"));
    await vi.waitFor(() =>
      expect(q.window("b")).toMatchObject({
        status: "ready",
        loadingOlder: false,
        error: undefined,
        hasMore: true,
      }),
    );
    expect(q.window("b").rows.map((row) => row.id)).toEqual([
      notice.id,
      ...bounded,
    ]);
    q.loadOlder("b");
    const resumed = await windowRead(wire, "b");
    expect(resumed.filters[0]).toMatchObject({
      before_id: notice.id,
      limit: 20,
    });
    resumed.respond([
      reply,
      bounds(relay, "b", after(notice), { has_more: false, next_cursor: null }),
    ]);
    await vi.waitFor(() =>
      expect(q.window("b")).toMatchObject({ hasMore: false, error: undefined }),
    );
    expect(q.window("b").rows.map((row) => row.id)).toEqual([
      reply.id,
      notice.id,
      ...bounded,
    ]);
    // A head whose continuation fails opens on the head the relay served.
    q.ensure("d");
    const served = joined("d", 10);
    (await windowRead(wire, "d")).respond([
      served,
      bounds(relay, "d", "head", {
        has_more: true,
        next_cursor: cursorAt(served),
      }),
    ]);
    (await windowRead(wire, "d")).fail(new Error("relay timeout"));
    await vi.waitFor(() =>
      expect(q.window("d")).toMatchObject({
        status: "ready",
        hasMore: true,
        error: undefined,
      }),
    );
    expect(q.window("d").rows.map((row) => row.id)).toEqual([served.id]);
    // A continuation without its bound fails the head read; ensure retries it.
    q.ensure("c");
    const lone = joined("c", 10);
    (await windowRead(wire, "c")).respond([
      lone,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: cursorAt(lone),
      }),
    ]);
    (await windowRead(wire, "c")).respond([]);
    await vi.waitFor(() =>
      expect(q.window("c")).toMatchObject({
        status: "error",
        rows: [],
        error: expect.stringMatching(/window bounds/),
      }),
    );
    q.ensure("c");
    expect((await windowRead(wire, "c")).filters[0]).not.toHaveProperty(
      "until",
    );
  } finally {
    owner.dispose();
  }
});

it("live activity obeys the same retained row budget as messages", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { maxHistoryRows: 2 },
  );
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    owner.session.channels.ensure("a");
    wire.next().respond([end()]);
    await flush();
    live.receive([
      addition(pinky.pubkey, 1),
      addition(pinky.pubkey, 2),
      addition(brain.pubkey, 3),
    ]);
    expect(owner.session.channels.window("a")).toMatchObject({
      historyLimited: true,
    });
    expect(
      owner.session.channels.window("a").rows.map((r) => r.createdAt),
    ).toEqual([2, 3]);
  } finally {
    owner.dispose();
  }
});

it("prepared disk heads retain signed membership evidence and subject profiles for warm restore", async () => {
  let saved: SavedHead[] = [];
  const disk: HeadPersistence = {
    read: async () => saved,
    write: async (record) => {
      saved = [record];
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const first = createRelaySession(wire.transport, {
    prepared: true,
    persistence: disk,
  });
  try {
    first.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    first.session.channels.prepare?.("a");
    wire.next().respond([addition(), end()]);
    await flush();
    wire
      .next()
      .respond([
        profile(viewer, { name: "Wes" }),
        profile(pinky, { name: "Pinky" }),
      ]);
    await flush();
    expect(saved[0]?.events).toContainEqual(
      expect.objectContaining({ id: addition().id, kind: 40099 }),
    );
    expect(saved[0]?.profiles).toHaveLength(2);
  } finally {
    first.dispose();
  }
  const secondWire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const second = createRelaySession(secondWire.transport, {
    prepared: true,
    persistence: disk,
  });
  try {
    second.session.channels.ensureList();
    secondWire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    await flush();
    second.session.channels.ensure("a");
    await vi.waitFor(() =>
      expect(
        second.session.channels.window("a").rows[0]?.membership?.target,
      ).toBe(pinky.pubkey),
    );
    expect(second.session.profiles.snapshot().get(pinky.pubkey)?.name).toBe(
      "Pinky",
    );
  } finally {
    second.dispose();
  }
});

it("a restored head continued past activity pages on from its last bound", async () => {
  let saved: SavedHead[] = [];
  const disk: HeadPersistence = {
    read: async () => saved,
    write: async (record) => {
      saved = [record];
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const join = addition(),
    chats = Array.from({ length: 20 }, (_, index) =>
      message(pinky, "a", `Before the joins ${index}`, 19 - index),
    );
  const open = async () => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession(wire.transport, {
      prepared: true,
      persistence: disk,
    });
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    return { wire, owner, q: owner.session.channels };
  };
  const first = await open();
  try {
    first.q.ensure("a");
    (await windowRead(first.wire)).respond([
      join,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(join),
      }),
    ]);
    (await windowRead(first.wire)).respond([
      ...chats,
      bounds(relay, "a", after(join), {
        has_more: true,
        next_cursor: cursorAt(last(chats)),
      }),
    ]);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
  } finally {
    first.owner.dispose();
  }
  const second = await open();
  try {
    second.q.ensure("a");
    await vi.waitFor(() =>
      expect(second.q.window("a").rows.map((row) => row.id)).toEqual([
        ...chats.map((chat) => chat.id).reverse(),
        join.id,
      ]),
    );
    // Revalidation fails; the restored rows stay and page on from the last chat.
    (await windowRead(second.wire)).fail(new Error("relay down"));
    await vi.waitFor(() =>
      expect(second.q.window("a")).toMatchObject({ error: "relay down" }),
    );
    second.q.loadOlder("a");
    expect((await windowRead(second.wire)).filters[0]).toMatchObject({
      until: 0,
      before_id: last(chats).id,
    });
  } finally {
    second.owner.dispose();
  }
});
