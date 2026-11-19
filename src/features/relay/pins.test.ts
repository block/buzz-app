import { assert, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "./events";
import type { LiveListener } from "./incoming";
import {
  LOADING_PINS,
  PIN_LIST_KIND,
  pinLists,
  pinnedIds,
  readPinnedMessages,
  type PinSource,
} from "./pins";

const relay = "a".repeat(64);
const other = "b".repeat(64);
const one = "1".repeat(64),
  two = "2".repeat(64),
  three = "3".repeat(64);
let serial = 0;
const event = (patch: Partial<EventData>): EventData => ({
  id: (serial++).toString(16).padStart(64, "0"),
  pubkey: relay,
  created_at: 100,
  kind: PIN_LIST_KIND,
  tags: [["d", "c"]],
  content: "",
  ...patch,
});
const list = (ids: string[], created_at = 100, channel = "c") =>
  event({
    created_at,
    tags: [["d", channel], ...ids.map((id) => ["e", id])],
  });

function source(
  read: (filters: readonly ReadFilter[]) => Promise<readonly EventData[]>,
  relayAuthor: string | null = relay,
  extra: Partial<PinSource> = {},
) {
  const listeners: LiveListener[] = [];
  const replays: boolean[] = [];
  const connection = new Set<() => void>();
  let status = "connected";
  const value: PinSource = {
    relayAuthor: relayAuthor ?? undefined,
    read: vi.fn(read),
    subscribeLive(listener, options) {
      listeners.push(listener);
      replays.push(!!options?.replay);
      return () => {};
    },
    live: {
      snapshot: () => ({ status }),
      subscribe(listener) {
        connection.add(listener);
        return () => connection.delete(listener);
      },
    },
    ...extra,
  };
  const deliver = (events: EventData[]) => {
    // The store reads only kind, pubkey, tags and created_at.
    for (const listener of listeners)
      listener({ events } as unknown as Parameters<LiveListener>[0]);
  };
  const connect = (next: string) => {
    status = next;
    for (const listener of connection) listener();
  };
  return { value, deliver, replays, connect };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("reads only a relay-signed list for its own channel, in order and deduped", () => {
  expect(pinnedIds(list([two, one, two, "bad"]), relay, "c")).toEqual([
    two,
    one,
  ]);
  expect(pinnedIds(list([one]), other, "c")).toBeUndefined();
  expect(pinnedIds(list([one], 100, "d"), relay, "c")).toBeUndefined();
  expect(pinnedIds(list([one]), undefined, "c")).toBeUndefined();
  expect(pinnedIds({ ...list([one]), kind: 9 }, relay, "c")).toBeUndefined();
  // An empty list is a d-only event.
  expect(pinnedIds(list([]), relay, "c")).toEqual([]);
});

it("reads the newest list once, then follows live and replayed lists", async () => {
  const filters: ReadFilter[][] = [];
  const s = source(async (read) => {
    filters.push([...read]);
    return [list([one])];
  });
  const store = pinLists(s.value);
  expect(pinLists(s.value)).toBe(store);
  const listener = vi.fn();
  store.subscribe("c", listener);
  store.subscribe("c", () => {});
  expect(store.snapshot("c").status).toBe("loading");
  await flush();
  expect(filters).toEqual([
    [{ kinds: [PIN_LIST_KIND], authors: [relay], "#d": ["c"], limit: 1 }],
  ]);
  // One replay listener: it hears live batches too.
  expect(s.replays).toEqual([true]);
  expect(store.snapshot("c")).toMatchObject({ status: "ready", ids: [one] });
  // A future-dated list is accepted; an older or foreign one is not.
  s.deliver([list([two, one], 9_999_999_999)]);
  expect(store.snapshot("c").ids).toEqual([two, one]);
  s.deliver([list([three], 101), { ...list([three]), pubkey: other }]);
  expect(store.snapshot("c").ids).toEqual([two, one]);
  expect(store.snapshot("c").set.has(two)).toBe(true);
  s.deliver([list([], 10_000_000_000)]);
  expect(store.snapshot("c").ids).toEqual([]);
  expect(listener).toHaveBeenCalled();
  expect(s.value.read).toHaveBeenCalledTimes(1);
});

it("treats no list as empty, shows none without relay self, and retries a failed read only when asked", async () => {
  const empty = source(async () => []);
  pinLists(empty.value).subscribe("c", () => {});
  await flush();
  expect(pinLists(empty.value).snapshot("c")).toMatchObject({
    status: "ready",
    ids: [],
  });

  const anonymous = source(async () => [list([one])], null);
  pinLists(anonymous.value).subscribe("c", () => {});
  await flush();
  expect(anonymous.value.read).not.toHaveBeenCalled();
  expect(pinLists(anonymous.value).snapshot("c").status).toBe("ready");
  anonymous.deliver([list([one])]);
  expect(pinLists(anonymous.value).snapshot("c").ids).toEqual([]);

  let fail = true;
  const flaky = source(async () => {
    if (fail) throw new Error("offline");
    return [list([one])];
  });
  const store = pinLists(flaky.value);
  const stop = store.subscribe("c", () => {});
  await flush();
  expect(store.snapshot("c").status).toBe("error");
  // Subscribing again, as a re-render does, never reads again by itself.
  stop();
  store.subscribe("c", () => {});
  await flush();
  expect(flaky.value.read).toHaveBeenCalledTimes(1);
  fail = false;
  store.retry("c");
  expect(store.snapshot("c").status).toBe("loading");
  await flush();
  expect(store.snapshot("c")).toMatchObject({ status: "ready", ids: [one] });
});

it("reads every watched list again in one read after a reconnect", async () => {
  const filters: ReadFilter[][] = [];
  const s = source(async (read) => {
    filters.push([...read]);
    return filters.length > 2
      ? [list([two], 200), list([three], 200, "d")]
      : [];
  });
  const store = pinLists(s.value);
  store.subscribe("c", () => {});
  store.subscribe("d", () => {});
  const stop = store.subscribe("e", () => {});
  await flush();
  stop();
  s.connect("retrying");
  s.connect("connected");
  await flush();
  // The unwatched list is dropped, and read again when next asked for.
  expect(filters.at(-1)).toEqual([
    { kinds: [PIN_LIST_KIND], authors: [relay], "#d": ["c", "d"], limit: 2 },
  ]);
  expect(store.snapshot("c").ids).toEqual([two]);
  expect(store.snapshot("d").ids).toEqual([three]);
  expect(store.snapshot("e")).toBe(LOADING_PINS);
});

it("loads pinned messages with edits applied and drops ids the relay no longer returns", async () => {
  const author = "c".repeat(64);
  const message = event({
    id: one,
    pubkey: author,
    kind: 9,
    content: "before",
    tags: [["h", "c"]],
  });
  const edit = event({
    pubkey: author,
    kind: 40003,
    created_at: 101,
    content: "after",
    tags: [
      ["h", "c"],
      ["e", one],
    ],
  });
  const filters: ReadFilter[][] = [];
  const s = source(async (read) => {
    filters.push([...read]);
    return [message, edit];
  });
  const rows = await readPinnedMessages(
    s.value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  expect([...rows.keys()]).toEqual([one]);
  expect(rows.get(one)?.content).toBe("after");
  expect(filters[0]?.[0]).toMatchObject({ ids: [one, two], "#h": ["c"] });
  expect(filters[1]?.[0]).toMatchObject({ "#e": [one, two] });

  const many = Array.from({ length: 150 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  filters.length = 0;
  await readPinnedMessages(s.value, "c", many, new AbortController().signal);
  expect(
    filters.flatMap((read) => (read[0]?.ids ? [read[0].ids.length] : [])),
  ).toEqual([100, 50]);
});

it("pages edits newest first until every pinned message is settled", async () => {
  const author = "c".repeat(64);
  const message = (id: string) =>
    event({
      id,
      pubkey: author,
      kind: 9,
      content: "original",
      tags: [["h", "c"]],
    });
  const edit = (target: string, created_at: number, content: string) =>
    event({
      pubkey: author,
      kind: 40003,
      created_at,
      content,
      tags: [
        ["h", "c"],
        ["e", target],
      ],
    });
  // A full page of newer edits to `one` pushes `two`'s edit to a later page.
  const newer = Array.from({ length: 500 }, (_, index) =>
    edit(one, 1000 + index, `one ${index}`),
  );
  const overlays: ReadFilter[] = [];
  const s = source(async ([filter]) => {
    if (filter?.ids) return [message(one), message(two)];
    assert.exists(filter);
    overlays.push(filter);
    return overlays.length === 1 ? newer : [edit(two, 900, "two edited")];
  });
  const rows = await readPinnedMessages(
    s.value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  expect(overlays).toEqual([
    { kinds: [5, 9005, 40003], "#e": [one, two], limit: 500 },
    { kinds: [5, 9005, 40003], "#e": [two], limit: 500, until: 1000 },
  ]);
  expect(rows.get(one)?.content).toBe("one 499");
  expect(rows.get(two)?.content).toBe("two edited");
});

it("folds pins with the session's signing authority and agent owners", async () => {
  const agent = "d".repeat(64),
    owner = "e".repeat(64),
    person = "f".repeat(64);
  const agentMessage = event({
    id: one,
    pubkey: agent,
    kind: 9,
    content: "draft",
    tags: [["h", "c"]],
  });
  const ownerEdit = event({
    pubkey: owner,
    kind: 40003,
    created_at: 101,
    content: "fixed by owner",
    tags: [
      ["h", "c"],
      ["e", one],
    ],
  });
  const relayed = event({
    id: two,
    pubkey: relay,
    kind: 9,
    content: "sent for someone",
    tags: [
      ["h", "c"],
      ["actor", person],
    ],
  });
  const s = source(
    async ([filter]) => (filter?.ids ? [agentMessage, relayed] : [ownerEdit]),
    relay,
    {
      workflowAuthority: relay,
      profiles: { owner: (pubkey) => (pubkey === agent ? owner : undefined) },
    },
  );
  const rows = await readPinnedMessages(
    s.value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  expect(rows.get(one)?.content).toBe("fixed by owner");
  expect(rows.get(two)?.authorId).toBe(person);
});
