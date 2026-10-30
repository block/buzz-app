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
import type { LiveCallbacks } from "./live";
import type { HeadPersistence, SavedHead } from "./persistence";
import { rowProfileIds } from "./membership";
import type { RelayEvent } from "./events";

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
type Wire = ReturnType<typeof scriptedTransport>;
/** The next pending read `match` selects, taken out of order. */
const take = (wire: Wire, match: (wire: Wire["pending"][number]) => boolean) =>
  vi.waitFor(() => {
    const index = wire.pending.findIndex(match);
    const [entry] = index < 0 ? [] : wire.pending.splice(index, 1);
    assert.exists(entry);
    return entry;
  });
const windowRead = (wire: Wire, channel = "a") =>
  take(
    wire,
    (entry) =>
      entry.filters[0]?.top_level === true &&
      entry.filters[0]["#h"]?.[0] === channel,
  );
const noticeRead = (wire: Wire, channel = "a") =>
  take(
    wire,
    (entry) =>
      entry.filters[0]?.kinds?.[0] === 40099 &&
      !entry.filters[0].top_level &&
      entry.filters[0]["#h"]?.[0] === channel,
  );
const cursorAt = (event: RelayEvent) => ({
  created_at: event.created_at,
  id: event.id,
});

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
      expect(q.window("a").rows.map((r) => r.id)).toEqual([row.id]);
      // A head that notices leave short of conversation reads it again without
      // them and shows it, then places the notices in its span.
      const conversation = await windowRead(wire);
      expect(conversation.filters[0]).toMatchObject({
        kinds: [40002, 40008, 48100, 48103, 9],
        limit: 20,
      });
      expect(conversation.filters[0]).not.toHaveProperty("until");
      const earlier = message(pinky, "a", "Before the join", 15);
      conversation.respond([
        earlier,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: cursorAt(earlier),
        }),
      ]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([earlier.id, row.id]);
      // Render before enrichment, with no per-row blocking request.
      // Notices are a background read, behind the names.
      const names = wire.next();
      expect([...(names.filters[0]?.authors ?? [])].sort()).toEqual(
        [viewer.pubkey, pinky.pubkey].sort(),
      );
      names.respond([
        profile(viewer, { name: "Wes" }),
        profile(pinky, { name: "Pinky" }),
      ]);
      await flush();
      const notices = await noticeRead(wire);
      expect(notices.filters[0]).toEqual({
        kinds: [40099],
        authors: [relay.pubkey],
        "#h": ["a"],
        limit: 500,
      });
      notices.respond([row]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([earlier.id, row.id]);
      const chat = message(pinky, "a", "Conversation preview", 21);
      live.receive([chat, addition(brain.pubkey, 22)]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([
        earlier.id,
        row.id,
        chat.id,
        addition(brain.pubkey, 22).id,
      ]);
      expect(q.list().channels[0]?.preview).toBe("Conversation preview");
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "a" })
          .observedCount,
      ).toBe(2);
      const moreNames = wire.next();
      expect(moreNames.filters[0]?.authors).toEqual([brain.pubkey]);
      moreNames.respond([profile(brain, { name: "Brain" })]);
      await flush();
      q.loadOlder("a");
      const older = wire.next();
      expect(older.filters[0]).toMatchObject({
        kinds: [40002, 40008, 40099, 48100, 48103, 9],
        until: 15,
        before_id: earlier.id,
      });
      const old = addition(brain.pubkey, 14);
      older.respond([
        old,
        bounds(relay, "a", `15:${earlier.id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([
        old.id,
        earlier.id,
        row.id,
        chat.id,
        addition(brain.pubkey, 22).id,
      ]);
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

it("a page that notices leave short shows its conversation, then the notices in its span", async () => {
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
  const owner = createRelaySession(wire.transport, {
    prepared: true,
    persistence: disk,
  });
  const q = owner.session.channels;
  const ids = () => q.window("a").rows.map((r) => r.id);
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
    const joined = addition(pinky.pubkey, 20);
    const arrived = addition(brain.pubkey, 19);
    const flood = [joined, arrived];
    (await windowRead(wire)).respond([
      ...flood,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(arrived),
      }),
    ]);
    await flush();
    expect(ids()).toEqual([arrived.id, joined.id]);
    const conversation = await windowRead(wire);
    expect(conversation.filters[0]).toMatchObject({
      kinds: [40002, 40008, 48100, 48103, 9],
      limit: 20,
    });
    const first = message(pinky, "a", "First", 12);
    const second = message(pinky, "a", "Second", 18);
    conversation.respond([
      first,
      second,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(first),
      }),
    ]);
    await flush();
    expect(ids()).toEqual([first.id, second.id, arrived.id, joined.id]);
    const between = addition(viewer.pubkey, 15);
    const below = addition(viewer.pubkey, 10);
    (await take(wire, (entry) => entry.filters[0]?.kinds?.[0] === 0)).respond(
      [],
    );
    (await noticeRead(wire)).respond([...flood, between, below]);
    await flush();
    // Notices older than the conversation read wait for the page that reads them.
    expect(ids()).toEqual([
      first.id,
      between.id,
      second.id,
      arrived.id,
      joined.id,
    ]);
    await vi.waitFor(() =>
      expect(saved[0]?.events).toContainEqual(
        expect.objectContaining({ id: between.id }),
      ),
    );
    const savedEvents = (saved[0]?.events ?? []) as RelayEvent[];
    expect(savedEvents.filter((event) => event.kind === 39006)).toEqual([
      expect.objectContaining({
        tags: expect.arrayContaining([["d", "a:head"]]),
      }),
    ]);
    q.loadOlder("a");
    const older = await windowRead(wire);
    expect(older.filters[0]).toMatchObject({
      kinds: [40002, 40008, 40099, 48100, 48103, 9],
      until: 12,
      before_id: first.id,
    });
    older.respond([
      below,
      bounds(relay, "a", `12:${first.id}`, {
        has_more: true,
        next_cursor: cursorAt(below),
      }),
    ]);
    await flush();
    const refill = await windowRead(wire);
    expect(refill.filters[0]).toMatchObject({
      kinds: [40002, 40008, 48100, 48103, 9],
      until: 12,
      before_id: first.id,
    });
    const oldest = message(pinky, "a", "Oldest", 8);
    refill.respond([
      oldest,
      bounds(relay, "a", `12:${first.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(ids().slice(0, 3)).toEqual([oldest.id, below.id, first.id]);
    expect(q.window("a").hasMore).toBe(false);
    // Notice reads are background reads, behind the profiles already asked for.
    (await take(wire, (entry) => entry.filters[0]?.kinds?.[0] === 0)).respond(
      [],
    );
    const notices = await noticeRead(wire);
    expect(notices.filters[0]).toMatchObject({ until: 12 });
    notices.respond([below]);
    await flush();
    expect(ids().slice(0, 3)).toEqual([oldest.id, below.id, first.id]);
  } finally {
    owner.dispose();
  }
});

it("a page of conversation reads once, and a failed fill keeps the page as read", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  const q = owner.session.channels;
  try {
    q.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        roster(relay, "b", [viewer.pubkey]),
      ]);
    await flush();
    q.ensure("a");
    const chat = Array.from({ length: 20 }, (_, index) =>
      message(pinky, "a", `Chat ${index}`, 30 + index),
    );
    (await windowRead(wire)).respond([
      addition(pinky.pubkey, 29),
      ...chat,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(addition(pinky.pubkey, 29)),
      }),
    ]);
    await flush();
    await flush();
    expect(wire.pending.some((entry) => entry.filters[0]?.top_level)).toBe(
      false,
    );
    q.ensure("b");
    const join = activity(
      { type: "member_joined", actor: viewer.pubkey, target: pinky.pubkey },
      20,
      relay,
      "b",
    );
    (await windowRead(wire, "b")).respond([
      join,
      bounds(relay, "b", "head", {
        has_more: true,
        next_cursor: cursorAt(join),
      }),
    ]);
    await flush();
    (await windowRead(wire, "b")).fail(new Error("relay down"));
    await flush();
    expect(q.window("b")).toMatchObject({ hasMore: true, error: undefined });
    expect(q.window("b").rows.map((r) => r.id)).toEqual([join.id]);
  } finally {
    owner.dispose();
  }
});
