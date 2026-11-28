import { afterEach, expect, test, vi } from "vitest";
import { queryEvents } from "../../../tests/fixtures/finder-data";
import type { RelayEvent } from "../relay/events";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { startDeviceIndex } from "./device-index";

const viewer = keypair();
const author = keypair();
const relay = keypair();
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.useRealTimers();
});

async function fixture(events: RelayEvent[], privateLab = false, cap?: number) {
  const all = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, author.pubkey]),
    metadata(
      relay,
      "lab",
      "lab",
      1_700_000_000,
      privateLab ? [["private"]] : [],
    ),
    roster(relay, "lab", [viewer.pubkey, author.pubkey]),
    // Readable but not joined: a preview, kept out of the index.
    metadata(relay, "away", "away"),
    roster(relay, "away", [author.pubkey]),
    ...events,
  ];
  // Message reads; the index must make none of its own.
  let reads = 0;
  const open = async () => {
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(9))) reads++;
        return queryEvents(all, filters);
      },
    });
    dispose.push(owner.dispose);
    vi.useRealTimers();
    await owner.session.channels.ensureList();
    vi.useFakeTimers();
    return owner;
  };
  const owner = await open();
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: "community:viewer",
    session: owner.session,
  };
  const listeners = new Set<() => void>();
  const data = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  const before = reads;
  const index = startDeviceIndex(data, cap);
  dispose.push(index.dispose);
  // Let the session settle its channel list, as the app does before search.
  await vi.advanceTimersByTimeAsync(5000);
  const found = (query = "quartz") =>
    index
      .search(query, 20)
      .map((m) => m.text)
      .sort();
  return {
    all,
    owner,
    index,
    found,
    readsOf: () => reads - before,
    open,
    publish(next: Partial<RelaySnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
}

test("holds what the session receives in channels you're in, with no reads of its own", async () => {
  const now = Math.floor(Date.now() / 1000);
  const crew = message(author, "crew", "Crew quartz", now - 60);
  const away = message(author, "away", "Preview quartz", now - 60);
  const { owner, found, readsOf } = await fixture([crew, away]);
  expect(found()).toEqual([]);
  expect(readsOf()).toBe(0);
  // The app reads both, as opening the channels would.
  await owner.session.read([{ ids: [crew.id, away.id], limit: 2 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Crew quartz"]);
});

test("past the cap, the oldest messages leave first", async () => {
  const now = Math.floor(Date.now() / 1000);
  // Arrival order differs from age: the oldest arrives last.
  const said = [
    message(author, "crew", "Newest quartz", now - 10),
    message(author, "crew", "Newer quartz", now - 20),
    message(author, "crew", "Older quartz", now - 30),
    message(author, "crew", "Oldest quartz", now - 40),
  ];
  const { owner, found } = await fixture(said, false, 3);
  for (const m of said) {
    await owner.session.read([{ ids: [m.id], limit: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(found()).toEqual(["Newer quartz", "Newest quartz"]);
});

test("a deletion removes its message and keeps it out when it arrives again; one that doesn't apply removes nothing", async () => {
  const now = Math.floor(Date.now() / 1000);
  const live = message(author, "crew", "Live quartz", now - 10);
  const moderated = message(author, "crew", "Moderated quartz", now - 10);
  const kept = message(author, "lab", "Kept quartz", now - 10);
  const stranger = keypair();
  const { owner, found } = await fixture([
    live,
    moderated,
    kept,
    signed(author, {
      kind: 5,
      content: "",
      created_at: now,
      tags: [
        ["h", "crew"],
        ["e", live.id],
        ["k", "9"],
      ],
    }),
    signed(author, {
      kind: 9005,
      content: "",
      created_at: now,
      tags: [
        ["h", "crew"],
        ["e", moderated.id],
      ],
    }),
    signed(stranger, {
      kind: 5,
      content: "",
      created_at: now,
      tags: [
        ["h", "lab"],
        ["e", kept.id],
      ],
    }),
  ]);
  await owner.session.read([
    { ids: [live.id, moderated.id, kept.id], limit: 3 },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Kept quartz", "Live quartz", "Moderated quartz"]);
  await owner.session.read([{ kinds: [5, 9005], limit: 10 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Kept quartz"]);
  await owner.session.read([{ ids: [live.id], limit: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Kept quartz"]);
});

test("losing a channel removes its messages at once", async () => {
  const now = Math.floor(Date.now() / 1000);
  const said = [
    message(viewer, "lab", "Lab quartz", now - 60),
    message(viewer, "crew", "Crew quartz", now - 60),
  ];
  const { all, owner, index, found } = await fixture(said, true);
  await owner.session.read([{ ids: said.map((m) => m.id), limit: 2 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Crew quartz", "Lab quartz"]);
  const lab = index.search("lab quartz", 20)[0]?.id ?? "";
  all.push(roster(relay, "lab", [author.pubkey], 1_700_000_100));
  await owner.session.read([
    { kinds: [39002], "#d": ["lab"], authors: [relay.pubkey], limit: 1 },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Crew quartz"]);
  expect(index.has(lab)).toBe(false);
});

test("a new session empties the index and fills it from its own traffic; signing out empties it", async () => {
  const now = Math.floor(Date.now() / 1000);
  const crew = message(author, "crew", "Crew quartz", now - 60);
  const later = message(author, "crew", "Later quartz", now - 30);
  const { owner, found, publish, open } = await fixture([crew, later]);
  await owner.session.read([{ ids: [crew.id], limit: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Crew quartz"]);
  const next = await open();
  publish({ status: "connecting" });
  publish({ status: "ready", generation: 2, session: next.session });
  expect(found()).toEqual([]);
  await vi.advanceTimersByTimeAsync(5000);
  await next.session.read([{ ids: [later.id], limit: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Later quartz"]);
  publish({ status: "disconnected" });
  expect(found()).toEqual([]);
});
