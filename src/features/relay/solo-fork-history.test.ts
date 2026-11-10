import { expect, it, vi } from "vitest";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import { readSoloFork, readSoloSeed } from "./solo-fork-history";
import { keypair, signed, message, metadata, bounds } from "./testing";

import type { SoloFork } from "./solo-fork-protocol";

const id = "44444444-4444-4444-8444-444444444444";
const source = "22222222-2222-4222-8222-222222222222";
const pointer = ["forked_from", source, "ab".repeat(32)];

it("reads fresh authority metadata, not an untrusted or wrong-channel pointer", async () => {
  const relay = keypair();
  const metadata = (author = relay, channel = id, tags: string[][] = []) =>
    eventDto(
      signed(author, {
        kind: 39000,
        content: "",
        created_at: 10,
        tags: [["d", channel], ...tags],
      }),
    );
  const read = vi.fn(async () => [
    metadata(keypair(), id, [pointer]),
    metadata(relay, source, [pointer]),
    metadata(),
  ]);
  const controller = new AbortController();
  const reader = { read, relayAuthor: () => relay.pubkey };
  await expect(
    readSoloFork(reader, id, controller.signal),
  ).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledExactlyOnceWith(
    [
      {
        kinds: [39000],
        authors: [relay.pubkey],
        "#d": [id],
        limit: 1,
        consistency: "strong",
      },
    ],
    controller.signal,
  );
  read.mockResolvedValue([{ ...metadata(relay, id, [pointer]) }]);
  await expect(readSoloFork(reader, id, controller.signal)).rejects.toThrow(
    "signed metadata could not be confirmed",
  );
  read.mockResolvedValue([metadata(relay, id, [pointer])]);
  await expect(readSoloFork(reader, id, controller.signal)).resolves.toEqual({
    channelId: source,
    messageId: pointer[2],
  });
  read.mockResolvedValue([metadata(relay, id, [pointer, pointer])]);
  await expect(readSoloFork(reader, id, controller.signal)).rejects.toThrow(
    "invalid source metadata",
  );
  read.mockResolvedValue([]);
  await expect(readSoloFork(reader, id, controller.signal)).rejects.toThrow(
    "signed metadata could not be confirmed",
  );
});

it("requires metadata authority and propagates read failure and cancellation", async () => {
  const controller = new AbortController();
  const read = vi.fn(async () => []);
  await expect(
    readSoloFork({ read, relayAuthor: () => undefined }, id, controller.signal),
  ).rejects.toThrow("authority is unavailable");
  expect(read).not.toHaveBeenCalled();
  const reader = { read, relayAuthor: () => keypair().pubkey };
  read.mockRejectedValueOnce(new Error("access revoked"));
  await expect(readSoloFork(reader, id, controller.signal)).rejects.toThrow(
    "access revoked",
  );
  controller.abort();
  await expect(
    readSoloFork(reader, id, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

function historyFixture() {
  const relay = keypair(),
    author = keypair();
  const controller = new AbortController();
  const pages = new Map<string, RelayEvent[]>();
  const forks = new Map<string, SoloFork>();
  const cutoffs = new Map<string, RelayEvent>();
  const meta = (channel: string) => {
    const fork = forks.get(channel);
    return eventDto(
      metadata(
        relay,
        channel,
        "Work",
        undefined,
        fork ? [["forked_from", fork.channelId, fork.messageId]] : [],
      ),
    );
  };
  const pageKey = (channel: string, cursor: string) => `${channel}/${cursor}`;
  const page = (
    channel: string,
    cursor: string,
    rows: RelayEvent[],
    next?: RelayEvent,
  ) => {
    pages.set(pageKey(channel, cursor), [
      ...rows,
      eventDto(
        bounds(relay, channel, cursor, {
          has_more: !!next,
          next_cursor: next
            ? { created_at: next.created_at, id: next.id }
            : null,
        }),
      ),
    ]);
  };
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const filter = filters[0];
    if (!filter) throw new Error("missing filter");
    const channel = filter["#h"]?.[0] ?? filter["#d"]?.[0] ?? "";
    if (filter.kinds?.includes(39000)) return [meta(channel)];
    if (filter.ids) {
      const cutoff = cutoffs.get(filter.ids[0] ?? "");
      return cutoff ? [cutoff] : [];
    }
    const cursor = filter.before_id
      ? `${filter.until}:${filter.before_id}`
      : "head";
    const result = pages.get(pageKey(channel, cursor));
    if (!result) throw new Error(`unexpected page ${channel}/${cursor}`);
    return result;
  });
  const row = (channel: string, content: string, time: number, ms = 0) =>
    eventDto(message(author, channel, content, time, [["ms", String(ms)]]));
  const fork = (destination: string, cutoff: RelayEvent) => {
    const parent = cutoff.tags.find(([name]) => name === "h")?.[1];
    if (!parent) throw new Error("cutoff has no channel");
    forks.set(destination, { channelId: parent, messageId: cutoff.id });
    cutoffs.set(cutoff.id, cutoff);
  };
  const cursor = (cutoff: RelayEvent) =>
    `${cutoff.created_at + 1}:${"f".repeat(64)}`;
  return {
    relay,
    author,
    controller,
    pages,
    forks,
    cutoffs,
    page,
    read,
    row,
    fork,
    cursor,
    reader: { read, relayAuthor: () => relay.pubkey },
  };
}

it("shares a destination-first twelve-row folded seed, completing same-second pages before selection", async () => {
  const test = historyFixture();
  const cutoff = test.row(source, "cutoff", 10, 500);
  test.fork(id, cutoff);
  test.page(id, "head", [test.row(id, "destination", 20)]);
  const sameSecond = Array.from({ length: 16 }, (_, n) =>
    test.row(source, `row ${n}`, 10, n * 20),
  );
  const wire = [...sameSecond, cutoff].sort((a, b) => a.id.localeCompare(b.id));
  const first = wire.slice(0, 12),
    lastFirst = first.at(-1);
  if (!lastFirst) throw new Error("missing page boundary");
  const edit = eventDto(
    signed(test.author, {
      kind: 40003,
      content: "edited",
      created_at: 30,
      tags: [
        ["h", source],
        ["e", cutoff.id],
      ],
    }),
  );
  test.page(source, test.cursor(cutoff), first, lastFirst);
  test.page(source, `${lastFirst.created_at}:${lastFirst.id}`, [
    ...wire.slice(12),
    edit,
  ]);
  const result = await readSoloSeed(test.reader, id, test.controller.signal);
  expect(result?.messages).toHaveLength(12);
  expect(result?.destination.map((row) => row.content)).toEqual([
    "destination",
  ]);
  expect(result?.inherited.map((row) => row.content)).toEqual([
    ...sameSecond.slice(-10).map((row) => row.content),
    "edited",
  ]);
  expect(test.read.mock.calls).toHaveLength(5);
});

it("fills remaining slots recursively, folds deletions, and never imports post-cutoff rows", async () => {
  const test = historyFixture();
  const ancestor = "33333333-3333-4333-8333-333333333333";
  const root = test.row(ancestor, "ancestor", 1);
  const deleted = test.row(source, "removed", 4);
  const cutoff = test.row(source, "parent", 5, 300);
  test.fork(id, cutoff);
  test.fork(source, root);
  const deletion = eventDto(
    signed(test.author, {
      kind: 5,
      content: "",
      created_at: 50,
      tags: [
        ["h", source],
        ["e", deleted.id],
      ],
    }),
  );
  test.page(id, "head", []);
  test.page(source, test.cursor(cutoff), [
    deleted,
    cutoff,
    test.row(source, "later", 5, 301),
    deletion,
  ]);
  test.page(ancestor, test.cursor(root), [root]);
  const result = await readSoloSeed(test.reader, id, test.controller.signal);
  expect(result?.messages.map((row) => row.content)).toEqual([
    "ancestor",
    "parent",
  ]);
  test.cutoffs.delete(cutoff.id);
  await expect(
    readSoloSeed(test.reader, id, test.controller.signal),
  ).rejects.toThrow("cutoff message is unavailable");
});

it("fails closed on unreadable ancestry, invalid bounds, cycles and incomplete budgets", async () => {
  const test = historyFixture();
  const cutoff = test.row(source, "parent", 5);
  test.fork(id, cutoff);
  test.page(id, "head", []);
  test.page(source, test.cursor(cutoff), [cutoff]);
  test.forks.set(source, { channelId: id, messageId: cutoff.id });
  await expect(
    readSoloSeed(test.reader, id, test.controller.signal),
  ).rejects.toThrow("cycle");
  test.forks.delete(source);
  test.pages.set(`${source}/${test.cursor(cutoff)}`, [cutoff]);
  await expect(
    readSoloSeed(test.reader, id, test.controller.signal),
  ).rejects.toThrow("invalid window bounds");
  test.read.mockRejectedValueOnce(new Error("access revoked"));
  await expect(
    readSoloSeed(test.reader, id, test.controller.signal),
  ).rejects.toThrow("access revoked");
  // Empty but advancing signed pages must not become an infinite walk or a false empty seed.
  test.read.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (filter?.kinds?.includes(39000))
      return [
        eventDto(
          metadata(test.relay, id, "Fork", undefined, [
            ["forked_from", source, cutoff.id],
          ]),
        ),
      ];
    const time = filter?.until ?? 100;
    const cursor = filter?.before_id ? `${time}:${filter.before_id}` : "head";
    return [
      eventDto(
        bounds(test.relay, id, cursor, {
          has_more: true,
          next_cursor: { created_at: time - 1, id: "a".repeat(64) },
        }),
      ),
    ];
  });
  await expect(
    readSoloSeed(test.reader, id, test.controller.signal),
  ).rejects.toThrow("exceeds the read budget");
});

it("uses the same strict pre-turn destination boundary and spends all twelve slots there before ancestry", async () => {
  const test = historyFixture();
  const cutoff = test.row(source, "parent", 1);
  const incoming = test.row(id, "new request", 20, 500);
  const destination = Array.from({ length: 12 }, (_, n) =>
    test.row(id, `own ${n}`, 19, n),
  );
  test.fork(id, cutoff);
  test.page(id, test.cursor(incoming), [
    ...destination,
    incoming,
    test.row(id, "future", 20, 501),
  ]);
  const result = await readSoloSeed(test.reader, id, test.controller.signal, {
    before: incoming,
  });
  expect(result?.messages.map((row) => row.id)).toEqual(
    destination.map((row) => row.id),
  );
  expect(result?.inherited).toEqual([]);
  expect(test.read.mock.calls).toHaveLength(2);
});
