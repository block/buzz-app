import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventData } from "./events";
import { foldMessages } from "./fold";
import { MessageProjection } from "./message-projection";
import {
  compareMessages,
  eventMs,
  nextMessageMs,
  observeMessageMs,
} from "./message-order";
import { createOutbox } from "./outbox";
import { createRelayProfiler } from "./profiling";
import { keypair, message, signed } from "./testing";

const alice = keypair(),
  viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});
const tagged = (content: string, second: number, ms: string) =>
  message(alice, "c", content, second, [["ms", ms]]);
const reply = (root: EventData, content: string, second: number, ms?: string) =>
  message(alice, "c", content, second, [
    ["e", root.id, "", "reply"],
    ...(ms ? [["ms", ms]] : []),
  ]);
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

it("orders by a valid ms tag, falls back to seconds, and breaks equal ms by ascending id", () => {
  const late = tagged("late", 100, "100900");
  const early = tagged("early", 100, "100100");
  const untagged = message(alice, "c", "untagged", 100);
  const outside = tagged("outside its second", 100, "101500");
  const malformed = tagged("malformed", 100, "100.5e3");
  expect(eventMs(late)).toBe(100_900);
  expect(eventMs(untagged)).toBe(100_000);
  expect(eventMs(outside)).toBe(100_000);
  expect(eventMs(malformed)).toBe(100_000);

  const rows = foldMessages("c", relay.pubkey, [late, untagged, early]);
  expect(ids(rows)).toEqual([untagged.id, early.id, late.id]);

  const [first, second] = [
    tagged("x", 100, "100500"),
    tagged("y", 100, "100500"),
  ].sort((a, b) => a.id.localeCompare(b.id));
  assert.exists(first);
  assert.exists(second);
  expect(
    ids(foldMessages("c", relay.pubkey, [second, first, outside, malformed])),
  ).toEqual(
    [
      { id: first.id, createdAt: 100, createdAtMs: 100_500 },
      { id: second.id, createdAt: 100, createdAtMs: 100_500 },
      { id: outside.id, createdAt: 100 },
      { id: malformed.id, createdAt: 100 },
    ]
      .sort(compareMessages)
      .map((row) => row.id),
  );
  expect(ids(foldMessages("c", relay.pubkey, [second, first]))).toEqual([
    first.id,
    second.id,
  ]);
});

it("renders channel and thread orderings identically", () => {
  const root = message(alice, "c", "root", 10);
  const replies = [
    reply(root, "c", 20, "20900"),
    reply(root, "a", 20),
    reply(root, "b", 20, "20100"),
    reply(root, "d", 20, "20100"),
    reply(root, "e", 20, "21999"),
  ];
  const events = [root, ...replies];
  const channel = new MessageProjection(
    "c",
    relay.pubkey,
    createRelayProfiler(),
    () => true,
  ).reconcile(events, []);
  const thread = foldMessages("c", relay.pubkey, [...events].reverse(), {
    includeReplies: true,
  });
  expect(ids(channel)).toEqual(ids(thread));
  expect(ids(channel)).toEqual(ids([...channel].sort(compareMessages)));
});

it("clamps an allocation more than 5s ahead of the local clock to now", () => {
  const now = 2_000_000_000_000;
  observeMessageMs("clamp", now + 4999);
  expect(nextMessageMs("clamp", now)).toBe(now + 5000);
  observeMessageMs("clamp", now + 5000);
  expect(nextMessageMs("clamp", now)).toBe(now);
  // The device's own last send stays within the bound for the next allocation.
  expect(nextMessageMs("elsewhere", now)).toBe(now + 1);
});

it("renders three same-second sends in send order and never moves them on replacement", async () => {
  const now = 2_100_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const channel = "burst";
  observeMessageMs(channel, now + 700); // Another author's newer message.
  const sign = vi.fn(async (event) => signed(viewer, event));
  const owner = createOutbox(
    viewer.pubkey,
    { sign, publish: async () => {} },
    { load: () => [], save: () => {} },
  );
  owners.push(owner);
  await owner.ready;
  const sent = ["yeah", "nice", "love it"].map((content) =>
    owner.outbox.send({ kind: 9, content, tags: [["h", channel]] }),
  );
  const local = owner.outbox.snapshot();
  expect(local.map((item) => item.event.id)).toEqual(sent);
  expect(local.map((item) => item.event.tags.at(-1))).toEqual([
    ["ms", String(now + 701)],
    ["ms", String(now + 702)],
    ["ms", String(now + 703)],
  ]);
  expect(local.map((item) => item.event.created_at)).toEqual([
    Math.floor(now / 1000),
    Math.floor(now / 1000),
    Math.floor(now / 1000),
  ]);

  const projection = new MessageProjection(
    channel,
    relay.pubkey,
    createRelayProfiler(),
  );
  const optimistic = projection.reconcile(
    local.map((item) => item.event),
    local,
  );
  expect(ids(optimistic)).toEqual(sent);

  await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(3));
  const relayed = await Promise.all(
    sign.mock.results.map((result) => result.value),
  );
  // The relay copy of the middle message replaces its optimistic row first.
  const [one, , three] = local;
  assert.exists(one);
  assert.exists(three);
  const replaced = projection.reconcile(
    [one.event, relayed[1], three.event],
    [one, three],
  );
  expect(ids(replaced)).toEqual(sent);
  expect(replaced.map((row) => row.createdAtMs)).toEqual(
    optimistic.map((row) => row.createdAtMs),
  );
  expect(ids(projection.reconcile(relayed, []))).toEqual(sent);
  clock.mockRestore();
});
