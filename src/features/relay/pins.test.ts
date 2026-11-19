import { expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "./events";
import type { LiveListener } from "./incoming";
import {
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
) {
  const listeners: LiveListener[] = [];
  const replays: boolean[] = [];
  const value: PinSource = {
    relayAuthor: relayAuthor ?? undefined,
    read: vi.fn(read),
    subscribeLive(listener, options) {
      listeners.push(listener);
      replays.push(!!options?.replay);
      return () => {};
    },
  };
  const deliver = (events: EventData[]) => {
    // The store reads only kind, pubkey, tags and created_at.
    for (const listener of listeners)
      listener({ events } as unknown as Parameters<LiveListener>[0]);
  };
  return { value, deliver, replays };
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
  expect(s.replays).toEqual([false, true]);
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

it("treats no list as empty, shows none without relay self, and retries a failed read", async () => {
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
  stop();
  fail = false;
  store.subscribe("c", () => {});
  await flush();
  expect(store.snapshot("c")).toMatchObject({ status: "ready", ids: [one] });
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
  expect(filters[0]?.[1]).toMatchObject({ "#e": [one, two] });

  const many = Array.from({ length: 150 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  filters.length = 0;
  await readPinnedMessages(s.value, "c", many, new AbortController().signal);
  expect(filters.map((read) => read[0]?.ids?.length)).toEqual([100, 50]);
});
