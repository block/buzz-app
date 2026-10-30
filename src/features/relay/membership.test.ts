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
import { ReadError } from "./errors";

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
      // A head of only activity fills on to a conversational row or the start.
      const older = await windowRead(wire);
      expect(older.filters[0]).toMatchObject({
        kinds: [40002, 40008, 40099, 48100, 48103, 9],
        until: 20,
        before_id: row.id,
        limit: 20,
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
      const joins = Array.from({ length: 300 }, (_, index) =>
        addition(pinky.pubkey, 1000 - index),
      );
      const conversation = Array.from({ length: 25 }, (_, index) =>
        message(brain, "a", `Conversation ${index}`, 500 - index),
      );
      const history = [...joins, ...conversation];
      const oldest = message(brain, "a", "Oldest", 400),
        arrival = message(brain, "a", "Arrived meanwhile", 2000);
      q.ensure("a");
      const head = await windowRead(wire);
      expect(head.filters[0]).toMatchObject({ limit: 20 });
      expect(head.filters[0]).not.toHaveProperty("until");
      const newest = history.slice(0, 20);
      head.respond([
        ...newest,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: cursorAt(last(newest)),
        }),
      ]);
      // Fill reads start at the shortfall and double while notices fill them.
      let served = newest;
      for (const limit of [20, 40, 80, 160]) {
        const read = await windowRead(wire);
        expect(read.filters[0]).toMatchObject({
          until: last(served).created_at,
          before_id: last(served).id,
          limit,
        });
        if (limit === 20) {
          // The head shows at once; the fill goes on as Load older would.
          expect(q.window("a")).toMatchObject({
            status: "ready",
            loadingOlder: true,
          });
          expect(q.window("a").rows).toHaveLength(20);
          live.receive([arrival]);
        }
        const page = history.slice(served.length, served.length + limit);
        read.respond([
          ...page,
          bounds(relay, "a", after(last(served)), {
            has_more: true,
            next_cursor: cursorAt(last(page)),
          }),
        ]);
        served = [...served, ...page];
      }
      await vi.waitFor(() =>
        expect(q.window("a")).toMatchObject({
          status: "ready",
          hasMore: true,
          loadingOlder: false,
        }),
      );
      const shown = [...served.map((row) => row.id).reverse(), arrival.id];
      expect(shown).toHaveLength(321);
      expect(q.window("a").rows.map((row) => row.id)).toEqual(shown);
      // The read that filled a page of conversation is complete: nothing else pages.
      expect(windowReads(wire)).toBe(0);
      q.loadOlder("a");
      const older = await windowRead(wire);
      expect(older.filters[0]).toMatchObject({
        until: last(served).created_at,
        before_id: last(served).id,
        limit: 20,
      });
      const rest = history.slice(served.length);
      older.respond([
        ...rest,
        oldest,
        bounds(relay, "a", after(last(served)), {
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
        ...rest.map((row) => row.id).reverse(),
        ...shown,
      ]);
      expect(windowReads(wire)).toBe(0);
    } finally {
      owner.dispose();
    }
  },
);

it("activity-only history fills to its start or the read bound, a failed fill read fails like Load older, and a mixed page reads only its shortfall", async () => {
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
      roster(relay, "e", [viewer.pubkey]),
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
    for (const limit of [20, 40, 80, 160, 200]) {
      const page = run.length;
      const read = await windowRead(wire, "b");
      expect(read.filters[0]).toMatchObject({
        before_id: last(run).id,
        limit,
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
      expect(q.window("b")).toMatchObject({
        status: "ready",
        hasMore: true,
        loadingOlder: false,
      }),
    );
    const bounded = run.map((join) => join.id).reverse();
    expect(q.window("b").rows.map((row) => row.id)).toEqual(bounded);
    expect(windowReads(wire)).toBe(0);
    // A failed fill read fails like Load older: the pages read stay and Load
    // older pages on from the last bound.
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
    (await windowRead(wire, "b")).fail(
      new ReadError("unavailable", "relay down", 429, 60_000),
    );
    await vi.waitFor(() =>
      expect(q.window("b")).toMatchObject({
        status: "ready",
        loadingOlder: false,
        error: "relay down",
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
    // A page with a few notices reads only the rows they displaced.
    q.ensure("e");
    const mixed = [
      ...Array.from({ length: 19 }, (_, index) =>
        message(brain, "e", `Mixed ${index}`, 60 - index),
      ),
      joined("e", 40),
    ];
    (await windowRead(wire, "e")).respond([
      ...mixed,
      bounds(relay, "e", "head", {
        has_more: true,
        next_cursor: cursorAt(last(mixed)),
      }),
    ]);
    const shortfall = await windowRead(wire, "e");
    expect(shortfall.filters[0]).toMatchObject({
      before_id: last(mixed).id,
      limit: 1,
    });
    // When that row is a notice too, the next read takes at least a page.
    const another = joined("e", 35);
    shortfall.respond([
      another,
      bounds(relay, "e", after(last(mixed)), {
        has_more: true,
        next_cursor: cursorAt(another),
      }),
    ]);
    const page = await windowRead(wire, "e");
    expect(page.filters[0]).toMatchObject({ before_id: another.id, limit: 20 });
    const filler = message(brain, "e", "Filler", 30);
    page.respond([
      filler,
      bounds(relay, "e", after(another), {
        has_more: true,
        next_cursor: cursorAt(filler),
      }),
    ]);
    await vi.waitFor(() =>
      expect(q.window("e")).toMatchObject({
        status: "ready",
        hasMore: true,
        loadingOlder: false,
      }),
    );
    expect(q.window("e").rows).toHaveLength(22);
    expect(windowReads(wire)).toBe(0);
  } finally {
    owner.dispose();
  }
});

it("an older page fills only within the remaining history row budget", async () => {
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
    { maxHistoryRows: 25 },
  );
  const q = owner.session.channels;
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    q.ensure("a");
    const chats = Array.from({ length: 20 }, (_, index) =>
      message(brain, "a", `Chat ${index}`, 100 - index),
    );
    (await windowRead(wire)).respond([
      ...chats,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(last(chats)),
      }),
    ]);
    await vi.waitFor(() => expect(q.window("a").status).toBe("ready"));
    q.loadOlder("a");
    const join = addition(pinky.pubkey, 70);
    (await windowRead(wire)).respond([
      join,
      bounds(relay, "a", after(last(chats)), {
        has_more: true,
        next_cursor: cursorAt(join),
      }),
    ]);
    const continuation = await windowRead(wire);
    expect(continuation.filters[0]).toMatchObject({
      before_id: join.id,
      limit: 4,
    });
    const joins = Array.from({ length: 4 }, (_, index) =>
      addition(brain.pubkey, 69 - index),
    );
    continuation.respond([
      ...joins,
      bounds(relay, "a", after(join), {
        has_more: true,
        next_cursor: cursorAt(last(joins)),
      }),
    ]);
    await vi.waitFor(() =>
      expect(q.window("a")).toMatchObject({
        loadingOlder: false,
        hasMore: true,
      }),
    );
    expect(q.window("a").rows).toHaveLength(25);
    expect(windowReads(wire)).toBe(0);
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

it("a prefetched head of activity fills when its channel opens", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport, { prepared: true });
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
    q.prepare?.("a");
    const join = addition();
    (await windowRead(wire)).respond([
      join,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(join),
      }),
    ]);
    await flush();
    // Prefetch reads the head alone; opening shows it and fills behind it.
    expect(windowReads(wire)).toBe(0);
    q.ensure("a");
    expect(q.window("a")).toMatchObject({
      status: "ready",
      loadingOlder: true,
    });
    expect((await windowRead(wire)).filters[0]).toMatchObject({
      before_id: join.id,
      limit: 20,
    });
  } finally {
    owner.dispose();
  }
});

it("a head of activity read by a catch-up fills once it settles", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize() {}, retry() {}, dispose() {} };
    },
  });
  const q = owner.session.channels;
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    q.ensure("a");
    await flush();
    const join = addition();
    (await windowRead(wire)).respond([
      join,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: cursorAt(join),
      }),
    ]);
    expect((await windowRead(wire)).filters[0]).toMatchObject({
      before_id: join.id,
      limit: 20,
    });
  } finally {
    owner.dispose();
  }
});
