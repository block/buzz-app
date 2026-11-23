import { afterEach, expect, it } from "vitest";
import type { LiveCallbacks } from "./live";
import { newReadJournal } from "./read-state-storage";
import { createRelaySession } from "./session";
import {
  bounds,
  completeHeads,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  type Scripted,
} from "./testing";

// An open paints once, from one fresh or provably current head, with the
// line from that same head. These follow it through `channels.open`, as
// navigation calls it, against a relay the test answers by hand. Ported from
// drone00's review probes of the structural pass.

const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

/** `readState`: the viewer has read the channel through 1700000001. */
function setup(readState = false) {
  const relay = keypair();
  const viewer = keypair();
  const peer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const journal = newReadJournal();
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      ...(readState ? { readState: { decode: async () => [] } } : {}),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, prioritize() {}, retry() {}, dispose() {} };
      },
    },
    {
      prepared: true,
      warm: false,
      ...(readState
        ? {
            readStateFloor: () => 1700000001,
            readStateStorage: {
              capture: async () => ({
                ...journal,
                state: {
                  ...journal.state,
                  frontiers: { kept: 1700000001 },
                },
              }),
              update: async (change) => change(journal),
              close() {},
            },
          }
        : {}),
    },
  );
  owners.push(owner);
  const known = (id: string) => [
    roster(relay, id, [viewer.pubkey]),
    metadata(relay, id, id),
  ];
  /** Head reads still out (a cancelled one stays in `pending`). */
  const headReads = () =>
    wire.pending.filter(
      (read) =>
        read.filters[0]?.top_level &&
        read.filters[0]?.until === undefined &&
        !read.signal?.aborted,
    );
  /** Answer one head read as the channel's whole history, leaving the rest. */
  const answer = (read: Scripted, rows: ReturnType<typeof message>[]) => {
    wire.pending.splice(wire.pending.indexOf(read), 1);
    completeHeads({ pending: [read] }, relay, rows);
  };
  return {
    relay,
    viewer,
    peer,
    wire,
    owner,
    channels: owner.session.channels,
    get live() {
      return live;
    },
    known,
    connected: () => live.state({ status: "connected", routes: [] }),
    headReads,
    answer,
  };
}

/** The open's head left before Alpha's route came up; the catch-up's after. */
async function openAcrossEstablishment() {
  const h = setup();
  h.live.receive(h.known("alpha"));
  h.channels.open?.("alpha");
  await flush();
  expect(h.headReads()).toHaveLength(1);
  h.connected();
  h.live.established("alpha");
  h.channels.ensure("alpha");
  await flush();
  expect(h.headReads()).toHaveLength(2);
  const [early, later] = h.headReads() as [Scripted, Scripted];
  const row = message(h.viewer, "alpha", "before the route", 1700000001);
  const missing = message(
    h.viewer,
    "alpha",
    "missed by the early head",
    1700000002,
  );
  return { h, early, later, row, missing };
}

it("an open whose early head lands first waits for the read that covers the gap, then paints it whole", async () => {
  const { h, early, later, row, missing } = await openAcrossEstablishment();
  h.answer(early, [row]);
  await flush();
  await flush();
  // The early head leaves a gap the stream never filled: no screen yet, and
  // the open asked for no third read: it joined the catch-up's.
  expect(h.channels.window("alpha").screen).toBe("gathering");
  expect(h.headReads()).toEqual([later]);
  h.answer(later, [row, missing]);
  await flush();
  await flush();
  const ready = h.channels.window("alpha");
  expect(ready.screen).toBe("ready");
  expect(ready.rows.map((r) => r.id)).toEqual([row.id, missing.id]);
  // Nothing is added to the screen after it is ready.
  for (const read of h.wire.pending.splice(0)) read.respond([]);
  await flush();
  expect(h.channels.window("alpha").rows.map((r) => r.id)).toEqual([
    row.id,
    missing.id,
  ]);
});

it("a route that comes up while an open reads its names paints the covering head, not the early one", async () => {
  const h = setup();
  h.live.receive(h.known("alpha"));
  h.connected();
  h.channels.open?.("alpha");
  await flush();
  const [early] = h.headReads() as [Scripted];
  const row = message(h.peer, "alpha", "before the route", 1700000001);
  const missing = message(
    h.peer,
    "alpha",
    "missed by the early head",
    1700000002,
  );
  h.answer(early, [row]);
  // The head lands, and the open waits a task for the name it shows: the
  // route comes up in that task.
  await flush();
  h.live.established("alpha");
  await flush();
  await flush();
  expect(h.channels.window("alpha").screen).toBe("gathering");
  const [covering] = h.headReads() as [Scripted];
  expect(covering).toBeDefined();
  h.answer(covering, [row, missing]);
  await flush();
  await flush();
  const ready = h.channels.window("alpha");
  expect(ready.screen).toBe("ready");
  expect(ready.rows.map((r) => r.id)).toEqual([row.id, missing.id]);
});

it("an open whose early head lands last paints the covering head, rows and line together", async () => {
  const { h, early, later, row, missing } = await openAcrossEstablishment();
  h.answer(later, [row, missing]);
  await flush();
  await flush();
  expect(h.channels.window("alpha").screen).toBe("gathering");
  h.answer(early, [row]);
  await flush();
  await flush();
  const ready = h.channels.window("alpha");
  expect(ready.screen).toBe("ready");
  expect(ready.rows.map((r) => r.id)).toEqual([row.id, missing.id]);
  expect(h.headReads()).toEqual([]);
});

it("an unrelated revocation before the roster completes cancels an unknown channel's read", async () => {
  const h = setup();
  h.live.receive([...h.known("kept"), ...h.known("about-to-lose")]);
  await flush();
  const outstanding = h.owner.session
    .read([{ kinds: [9], "#h": ["unknown"], limit: 5 }])
    .catch(() => []);
  const kept = h.owner.session
    .read([{ kinds: [9], "#h": ["kept"], limit: 5 }])
    .catch(() => []);
  await flush();
  const unknown = h.wire.pending.find((r) =>
    r.filters[0]?.["#h"]?.includes("unknown"),
  );
  const confirmed = h.wire.pending.find((r) =>
    r.filters[0]?.["#h"]?.includes("kept"),
  );
  expect(unknown && confirmed).toBeDefined();
  h.live.receive([roster(h.relay, "about-to-lose", [], 1700000001)]);
  await flush();
  expect(h.channels.list().channels.some((c) => c.id === "about-to-lose")).toBe(
    false,
  );
  // Nothing has ruled the unknown channel out, but nothing confirms it: its
  // read retires. The confirmed channel's read stands.
  expect(unknown?.signal?.aborted).toBe(true);
  expect(confirmed?.signal?.aborted).toBe(false);
  confirmed?.respond([]);
  await Promise.all([outstanding, kept]);
});

it("the first complete roster leaves a confirmed channel's open gathering, and it paints", async () => {
  const h = setup();
  h.live.receive(h.known("kept"));
  h.channels.open?.("kept");
  h.channels.ensure("kept");
  await flush();
  const [first] = h.headReads();
  expect(first).toBeDefined();
  h.connected();
  h.live.established();
  await flush();
  const scan = h.wire.pending.find((r) => r.filters[0]?.kinds?.includes(39002));
  expect(scan).toBeDefined();
  scan?.respond(h.known("kept"));
  await flush();
  expect(first?.signal?.aborted).toBe(false);
  completeHeads(h.wire, h.relay, [
    message(h.viewer, "kept", "fresh after the roster", 1700000001),
  ]);
  await flush();
  for (const r of h.wire.pending.splice(0)) r.respond([]);
  await flush();
  await flush();
  const window = h.channels.window("kept");
  expect({ screen: window.screen, rows: window.rows.length }).toEqual({
    screen: "ready",
    rows: 1,
  });
});

it("an access change that cancels an unconfirmed channel's ensure read reads it again, and its open paints", async () => {
  const h = setup();
  h.live.receive(h.known("about-to-lose"));
  await flush();
  // A link to a channel no roster has confirmed or ruled out yet.
  h.channels.open?.("linked");
  h.channels.ensure("linked");
  await flush();
  const [first] = h.headReads();
  expect(first?.filters[0]?.["#h"]).toEqual(["linked"]);
  h.live.receive([roster(h.relay, "about-to-lose", [], 1700000001)]);
  await flush();
  await flush();
  expect(first?.signal?.aborted).toBe(true);
  // The window reads again (the open itself waits for the roster to
  // classify the channel), never stuck gathering.
  const again = h.headReads();
  expect(again).toHaveLength(1);
  expect(again[0]).not.toBe(first);
  h.live.receive(h.known("linked"));
  completeHeads(h.wire, h.relay, [
    message(h.viewer, "linked", "after the change", 1700000002),
  ]);
  await flush();
  await flush();
  const window = h.channels.window("linked");
  expect({ screen: window.screen, rows: window.rows.length }).toEqual({
    screen: "ready",
    rows: 1,
  });
});

it("a live arrival while a head is out, its tail evicted, never paints as current without it", async () => {
  const h = setup();
  const others = Array.from({ length: 64 }, (_, i) => `ch${i}`);
  h.live.receive(["alpha", ...others].flatMap(h.known));
  h.connected();
  h.live.established("alpha");
  h.channels.prepare?.("alpha");
  await flush();
  expect(h.headReads()).toHaveLength(1);
  const arrival = message(
    h.viewer,
    "alpha",
    "arrived during the head read",
    1700000002,
  );
  h.live.receive([arrival]);
  // Activity in 64 other channels evicts Alpha's tail.
  h.live.receive(
    others.map((id) => message(h.viewer, id, "other activity", 1700000002)),
  );
  await flush();
  // The relay answered from before the arrival.
  completeHeads(h.wire, h.relay, [
    message(h.viewer, "alpha", "old head", 1700000001),
  ]);
  for (let i = 0; i < 4; i++) {
    await flush();
    for (const r of h.wire.pending.splice(0)) r.respond([]);
  }
  await flush();
  h.channels.open?.("alpha");
  const opening = h.channels.window("alpha");
  expect(
    opening.screen === "gathering" ||
      opening.rows.some((row) => row.id === arrival.id),
  ).toBe(true);
});

it("a head the stream does not follow is not current, however recent", async () => {
  const h = setup();
  h.live.receive(h.known("alpha"));
  h.channels.prepare?.("alpha");
  await flush();
  completeHeads(h.wire, h.relay, [
    message(h.viewer, "alpha", "read with no route up", 1700000001),
  ]);
  await flush();
  await flush();
  for (const r of h.wire.pending.splice(0)) r.respond([]);
  await flush();
  // Read a moment ago, but nothing followed Alpha since: the open gathers.
  h.channels.open?.("alpha");
  expect(h.channels.window("alpha").screen).toBe("gathering");
});

/** Open Kept and paint `row` with HTTP up but no live route for it, then
 * switch to Other and back. */
async function revisitWithNoRoute() {
  const h = setup();
  h.live.receive([
    ...h.known("kept"),
    ...h.known("other"),
    profile(h.peer, { name: "Peer" }),
  ]);
  h.connected();
  h.channels.open?.("kept");
  await flush();
  const row = message(h.peer, "kept", "read before the route", 1700000001);
  completeHeads(h.wire, h.relay, [row]);
  await flush();
  await flush();
  expect(h.channels.window("kept").screen).toBe("ready");
  h.channels.open?.("other");
  await flush();
  completeHeads(h.wire, h.relay, []);
  await flush();
  await flush();
  return { h, row };
}

it("a window read before its live route came up does not make a reopen current", async () => {
  const { h, row } = await revisitWithNoRoute();
  // The relay took a row meanwhile that no stream delivered: only a new head
  // has it, so the reopen gathers one rather than keep the window it holds.
  h.channels.open?.("kept");
  expect(h.channels.window("kept").screen).toBe("gathering");
  await flush();
  const missed = message(h.peer, "kept", "missed with no route", 1700000002);
  completeHeads(h.wire, h.relay, [row, missed]);
  await flush();
  await flush();
  const ready = h.channels.window("kept");
  expect(ready.screen).toBe("ready");
  expect(ready.rows.map((r) => r.id)).toEqual([row.id, missed.id]);
});

it("a head that left before the route came up is not current when it lands after", async () => {
  const h = setup();
  h.live.receive([
    ...h.known("kept"),
    ...h.known("other"),
    profile(h.peer, { name: "Peer" }),
  ]);
  h.connected();
  h.channels.ensure("kept");
  await flush();
  const [early] = h.headReads() as [Scripted];
  // The route comes up while the head is out; its catch-up waits behind it.
  h.live.established("kept");
  await flush();
  h.answer(early, [message(h.peer, "kept", "early", 1700000001)]);
  await flush();
  await flush();
  h.channels.open?.("kept");
  expect(h.channels.window("kept").screen).toBe("gathering");
});

for (const order of ["covering head first", "live arrival beside the head"]) {
  it(`the line sits above the first unread row the first screen shows, ${order}`, async () => {
    const h = setup(true);
    h.live.receive(h.known("kept"));
    await flush();
    h.connected();
    const read = message(h.peer, "kept", "already read", 1700000001);
    const unread = message(h.peer, "kept", "first unread", 1700000002);
    if (order !== "covering head first") h.live.established("kept");
    h.channels.open?.("kept");
    await flush();
    const [early] = h.headReads() as [Scripted];
    if (order === "covering head first") {
      h.live.established("kept");
      h.channels.ensure("kept");
      await flush();
      const [, later] = h.headReads() as [Scripted, Scripted];
      expect(later).not.toBe(early);
      h.answer(later, [read, unread]);
      await flush();
      await flush();
      expect(h.channels.window("kept").screen).toBe("gathering");
    } else {
      // The stream delivers the first unread row while the head is out.
      h.live.receive([unread]);
    }
    const shown: { rows: string[]; line: string | undefined }[] = [];
    const stop = h.channels.subscribeWindow("kept", () => {
      const window = h.channels.window("kept");
      if (window.screen === "ready")
        shown.push({
          rows: window.rows.map((r) => r.id),
          line: window.screenLine,
        });
    });
    h.answer(early, [read]);
    await flush();
    await flush();
    for (const r of h.wire.pending.splice(0)) r.respond([]);
    await flush();
    await flush();
    stop();
    expect(h.owner.session.unread.attention("kept", unread.id)).toMatchObject({
      unread: true,
    });
    // The first paint has the row and its line, and neither changes after.
    expect(shown.length).toBeGreaterThan(0);
    for (const paint of shown)
      expect(paint).toEqual({ rows: [read.id, unread.id], line: unread.id });
  });
}

// A continuous replay proves coverage through its establishment, not that
// the route still delivers. Ported from drone00's probe of `f1fa9b086d`.
for (const order of [
  "no route loss",
  "route closes after the resume",
  "route closes before its late continuous report",
] as const) {
  it(`only a route still delivering lets a resumed reopen use memory: ${order}`, async () => {
    const h = setup();
    const route = (status: "live" | "error") =>
      h.live.state({
        status: "connected",
        routes: [
          {
            id: "channel:kept",
            channelId: "kept",
            status,
            replay: "unknown",
            ...(status === "error" ? { error: "error: shutting down" } : {}),
          },
        ],
      });
    const drain = async () => {
      for (let i = 0; i < 3; i++) {
        await flush();
        for (const r of h.wire.pending.splice(0)) r.respond([]);
      }
      await flush();
    };
    h.live.receive([
      ...h.known("kept"),
      ...h.known("other"),
      profile(h.peer, { name: "Peer" }),
    ]);
    route("live");
    h.live.established("kept");
    h.channels.open?.("kept");
    await flush();
    const row = message(h.peer, "kept", "before the outage", 1700000001);
    completeHeads(h.wire, h.relay, [row]);
    await drain();
    expect(h.channels.window("kept")).toMatchObject({
      screen: "ready",
      freshness: "verified",
    });
    h.channels.open?.("other");
    await flush();
    completeHeads(h.wire, h.relay, []);
    await drain();
    h.live.state({ status: "retrying", routes: [] });
    h.connected();
    const replayed = message(h.peer, "kept", "replayed", 1700000002);
    h.live.receive([replayed], { phase: "replay", channelId: "kept" });
    // Late order: the route's error status overtakes its continuous report.
    route(
      order === "route closes before its late continuous report"
        ? "error"
        : "live",
    );
    h.live.established("kept", undefined, ["kept"]);
    if (order === "route closes after the resume") route("error");
    expect(h.channels.window("kept").rows.map((r) => r.id)).toEqual([
      row.id,
      replayed.id,
    ]);
    h.channels.open?.("kept");
    if (order === "no route loss") {
      expect(h.channels.window("kept").screen).toBe("ready");
      await flush();
      expect(h.headReads()).toHaveLength(0);
      return;
    }
    expect(h.channels.window("kept").screen).toBe("gathering");
    await flush();
    const missed = message(
      h.peer,
      "kept",
      "after the route closed",
      1700000003,
    );
    const paints: string[][] = [];
    const stop = h.channels.subscribeWindow("kept", () => {
      const window = h.channels.window("kept");
      if (window.screen === "ready") paints.push(window.rows.map((r) => r.id));
    });
    completeHeads(h.wire, h.relay, [row, replayed, missed]);
    await drain();
    stop();
    expect(paints[0]).toEqual([row.id, replayed.id, missed.id]);
    // A route that ended is not followed again by a later demand for it.
    h.channels.open?.("other");
    await drain();
    h.channels.open?.("kept");
    expect(h.channels.window("kept").screen).toBe("gathering");
  });
}

it("an open gathering names over held rows reads a fresh head when its route closes", async () => {
  const h = setup();
  const route = (status: "live" | "error") =>
    h.live.state({
      status: "connected",
      routes: [
        { id: "channel:kept", channelId: "kept", status, replay: "unknown" },
      ],
    });
  h.live.receive([...h.known("kept"), ...h.known("other")]);
  route("live");
  h.live.established("kept");
  h.channels.open?.("kept");
  await flush();
  const row = message(h.peer, "kept", "held", 1700000001);
  completeHeads(h.wire, h.relay, [row]);
  for (let i = 0; i < 3; i++) {
    await flush();
    // Leave the peer's profile read out: the screen waits on its name.
    for (const r of h.wire.pending.splice(0))
      if (!r.filters[0]?.kinds?.includes(0)) r.respond([]);
  }
  h.channels.open?.("other");
  await flush();
  completeHeads(h.wire, h.relay, []);
  await flush();
  // The reopen takes the held rows and waits on names alone.
  h.channels.open?.("kept");
  await flush();
  expect(h.headReads()).toHaveLength(0);
  route("error");
  await flush();
  await flush();
  // Its run starts again, and this time reads the head.
  expect(h.headReads()).toHaveLength(1);
});

/** The timeline's Retry messages, as `ChannelBody` calls it. */
function retry(h: ReturnType<typeof setup>, channelId: string) {
  h.channels.open?.(channelId);
  h.channels.ensure(channelId);
}
/** Every set of rows `channelId`'s window shows as its screen, in order. */
function painted(h: ReturnType<typeof setup>, channelId: string) {
  const screens: string[][] = [];
  h.channels.subscribeWindow(channelId, () => {
    const window = h.channels.window(channelId);
    const ids = window.rows.map((r) => r.id);
    if (
      window.screen !== "gathering" &&
      ids.length &&
      ids.join() !== screens.at(-1)?.join()
    )
      screens.push(ids);
  });
  return screens;
}
/** Pending reads of pages below the head. */
const olderReads = (h: ReturnType<typeof setup>) =>
  h.wire.pending.filter(
    (read) =>
      read.filters[0]?.top_level &&
      read.filters[0]?.until !== undefined &&
      !read.signal?.aborted,
  );

it("a failed reopen hides the rows it held, at the end of history, and its Retry paints a fresh screen once", async () => {
  const { h, row } = await revisitWithNoRoute();
  const screens = painted(h, "kept");
  h.channels.open?.("kept");
  await flush();
  expect(h.headReads()).toHaveLength(1);
  const [failing] = h.headReads() as [Scripted];
  failing.fail(new Error("Head unavailable"));
  await flush();
  await flush();
  // No fresh head or live route proved the old rows current: the open ends
  // in its error, which the timeline shows in its place with its Retry.
  expect(h.channels.window("kept")).toMatchObject({
    screen: "ready",
    status: "error",
    error: "Head unavailable",
    rows: [],
  });
  // The pane mounting over the error reads nothing.
  h.channels.ensure("kept");
  await flush();
  expect(h.headReads()).toHaveLength(0);
  retry(h, "kept");
  expect(h.channels.window("kept")).toMatchObject({
    screen: "gathering",
    rows: [],
  });
  await flush();
  expect(h.headReads()).toHaveLength(1);
  const missed = message(h.peer, "kept", "taken while it failed", 1700000002);
  completeHeads(h.wire, h.relay, [row, missed]);
  await flush();
  await flush();
  expect(h.channels.window("kept")).toMatchObject({
    screen: "ready",
    status: "ready",
    error: undefined,
  });
  expect(screens).toEqual([[row.id, missed.id]]);
});

it("a failed reopen with older history retries its head, not older pages", async () => {
  const h = setup();
  h.live.receive([
    ...h.known("kept"),
    ...h.known("other"),
    profile(h.peer, { name: "Peer" }),
  ]);
  h.connected();
  h.channels.open?.("kept");
  await flush();
  const row = message(h.peer, "kept", "the newest page", 1700000010);
  const [head] = h.headReads() as [Scripted];
  h.wire.pending.splice(h.wire.pending.indexOf(head), 1);
  head.respond([
    row,
    bounds(h.relay, "kept", "head", {
      has_more: true,
      next_cursor: { created_at: row.created_at, id: row.id },
    }),
  ]);
  await flush();
  await flush();
  expect(h.channels.window("kept")).toMatchObject({
    screen: "ready",
    hasMore: true,
  });
  h.channels.open?.("other");
  await flush();
  completeHeads(h.wire, h.relay, []);
  await flush();
  await flush();
  const screens = painted(h, "kept");
  h.channels.open?.("kept");
  await flush();
  const [failing] = h.headReads() as [Scripted];
  failing.fail(new Error("Head unavailable"));
  await flush();
  await flush();
  expect(h.channels.window("kept")).toMatchObject({
    screen: "ready",
    status: "error",
    rows: [],
  });
  // Paging is not how it recovers: the history edge is not shown.
  h.channels.loadOlder("kept");
  await flush();
  expect(olderReads(h)).toHaveLength(0);
  retry(h, "kept");
  await flush();
  expect(h.headReads()).toHaveLength(1);
  expect(olderReads(h)).toHaveLength(0);
  const fresh = message(h.peer, "kept", "after the failure", 1700000011);
  completeHeads(h.wire, h.relay, [row, fresh]);
  await flush();
  await flush();
  expect(h.channels.window("kept")).toMatchObject({
    screen: "ready",
    status: "ready",
  });
  expect(screens).toEqual([[row.id, fresh.id]]);
});

it("returning to a followed channel keeps its loaded older pages, unless its route stopped following", async () => {
  const h = setup();
  const route = (status: "live" | "error") =>
    h.live.state({
      status: "connected",
      routes: [
        { id: "channel:kept", channelId: "kept", status, replay: "unknown" },
      ],
    });
  h.live.receive([
    ...h.known("kept"),
    ...h.known("other"),
    profile(h.peer, { name: "Peer" }),
  ]);
  route("live");
  h.live.established("kept");
  h.channels.open?.("kept");
  await flush();
  const newer = message(h.peer, "kept", "newer head row", 1700000010);
  const older = message(h.peer, "kept", "older page row", 1700000005);
  const [head] = h.headReads() as [Scripted];
  h.wire.pending.splice(h.wire.pending.indexOf(head), 1);
  head.respond([
    newer,
    bounds(h.relay, "kept", "head", {
      has_more: true,
      next_cursor: { created_at: newer.created_at, id: newer.id },
    }),
  ]);
  await flush();
  await flush();
  h.channels.loadOlder("kept");
  await flush();
  const [page] = olderReads(h) as [Scripted];
  expect(page).toBeDefined();
  h.wire.pending.splice(h.wire.pending.indexOf(page), 1);
  page.respond([
    older,
    bounds(h.relay, "kept", `${newer.created_at}:${newer.id}`, {
      has_more: false,
      next_cursor: null,
    }),
  ]);
  await flush();
  await flush();
  expect(h.channels.window("kept").rows.map((r) => r.id)).toEqual([
    older.id,
    newer.id,
  ]);
  // Switch away and back while the stream still follows Kept: no head read,
  // and both pages stay.
  h.channels.open?.("other");
  await flush();
  completeHeads(h.wire, h.relay, []);
  await flush();
  await flush();
  h.channels.open?.("kept");
  expect(h.channels.window("kept").screen).toBe("ready");
  await flush();
  expect(h.headReads()).toHaveLength(0);
  expect(h.channels.window("kept").rows.map((r) => r.id)).toEqual([
    older.id,
    newer.id,
  ]);
  // Once its route closes, Kept is no longer followed: the next return
  // gathers a fresh head instead of keeping the unfollowed window.
  h.channels.open?.("other");
  await flush();
  completeHeads(h.wire, h.relay, []);
  await flush();
  await flush();
  route("error");
  h.channels.open?.("kept");
  expect(h.channels.window("kept").screen).toBe("gathering");
  await flush();
  expect(h.headReads()).toHaveLength(1);
});

it("an older page cannot recertify the head while its replacement route catches up", async () => {
  const h = setup();
  const route = (status: "live" | "error") =>
    h.live.state({
      status: "connected",
      routes: [
        { id: "channel:kept", channelId: "kept", status, replay: "unknown" },
      ],
    });
  h.live.receive([
    ...h.known("kept"),
    ...h.known("other"),
    profile(h.peer, { name: "Peer" }),
  ]);
  route("live");
  h.live.established("kept");
  h.channels.open?.("kept");
  await flush();
  const newer = message(h.peer, "kept", "newer head row", 1700000010);
  const older = message(h.peer, "kept", "older page row", 1700000005);
  const [head] = h.headReads() as [Scripted];
  h.wire.pending.splice(h.wire.pending.indexOf(head), 1);
  head.respond([
    newer,
    bounds(h.relay, "kept", "head", {
      has_more: true,
      next_cursor: { created_at: newer.created_at, id: newer.id },
    }),
  ]);
  await flush();
  await flush();
  expect(h.channels.window("kept").freshness).toBe("verified");
  h.channels.loadOlder("kept");
  await flush();
  const [page] = olderReads(h) as [Scripted];
  expect(page).toBeDefined();
  h.channels.open?.("other");
  await flush();
  completeHeads(h.wire, h.relay, []);
  await flush();
  await flush();
  route("error");
  route("live");
  h.live.established("kept");
  await flush();
  expect(h.headReads()).toHaveLength(1);
  expect(h.channels.window("kept").freshness).toBe("cached");
  expect(page.signal?.aborted).toBe(false);
  h.wire.pending.splice(h.wire.pending.indexOf(page), 1);
  page.respond([
    older,
    bounds(h.relay, "kept", `${newer.created_at}:${newer.id}`, {
      has_more: false,
      next_cursor: null,
    }),
  ]);
  await flush();
  await flush();
  expect(h.headReads()).toHaveLength(1);
  h.channels.open?.("kept");
  expect(h.channels.window("kept").screen).toBe("gathering");
});
