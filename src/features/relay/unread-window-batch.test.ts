import { expect, it } from "vitest";
import type { ReadFilter } from "./events";
import {
  isUnreadWindowBatch,
  UNREAD_WINDOW_BATCH,
} from "./unread-window-batch";

const kinds = [9, 40002, 40008];
const root = "a".repeat(64);
const viewer = "b".repeat(64);
const channel = (i: number) => `room-${i}`;
const window = (i: number, limit = 24): ReadFilter => ({
  kinds,
  "#h": [channel(i)],
  since: 1000,
  include_aux: true,
  limit,
});
/** The repair's shapes, 128 in all: the viewer's authored page, 125 channel
 * windows, a thread read whole and a root fetch. */
const batch: ReadFilter[] = [
  { kinds, authors: [viewer], include_aux: true, limit: 100 },
  ...Array.from({ length: 125 }, (_, i) => window(i)),
  { kinds, "#h": [channel(200)], "#e": [root], include_aux: true, limit: 200 },
  { kinds, ids: [root], include_aux: true, limit: 1 },
];
const windows = (change: (filter: ReadFilter) => ReadFilter) =>
  batch.map((filter) => (filter.since !== undefined ? change(filter) : filter));

it("admits each of the repair's shapes, up to 128 filters a request", () => {
  expect(batch).toHaveLength(UNREAD_WINDOW_BATCH);
  expect(isUnreadWindowBatch(batch)).toBe(true);
  for (const lone of [
    // A lone window at its last split limit, the authored page since the
    // walk mark, a cold thread since its newest time, a full root fetch.
    [window(1, 1)],
    [{ kinds, authors: [viewer], since: 5, include_aux: true, limit: 100 }],
    [
      {
        kinds,
        "#h": [channel(1)],
        "#e": [root],
        since: 5,
        include_aux: true,
        limit: 500,
      },
    ],
    [
      {
        kinds,
        ids: Array.from({ length: 100 }, (_, i) =>
          i.toString(16).padStart(64, "0"),
        ),
        include_aux: true,
        limit: 100,
      },
    ],
  ] as ReadFilter[][])
    expect(isUnreadWindowBatch(lone)).toBe(true);
});

it.each([
  ["no filters", []],
  ["129 filters", [...batch, window(300)]],
  ["a second authored page among 128", [...batch.slice(0, 127), batch[0]]],
  ["one content kind", batch.map((f) => ({ ...f, kinds: [9] }))],
  ["no include_aux", batch.map(({ include_aux: _aux, ...f }) => f)],
  ["a window without since", windows(({ since: _since, ...f }) => f)],
  [
    "two windows of one channel",
    windows((f) => ({ ...f, "#h": [channel(1)] })),
  ],
  ["a window with until", windows((f) => ({ ...f, until: 2000 }))],
  ["a window at limit 0", windows((f) => ({ ...f, limit: 0 }))],
  ["a window over limit 500", windows((f) => ({ ...f, limit: 501 }))],
  ["a window since before 0", windows((f) => ({ ...f, since: -1 }))],
  [
    "an authored page of two keys",
    [{ ...batch[0], authors: [viewer, root] }, ...batch.slice(1)],
  ],
  [
    "a cold thread read of two roots",
    [
      {
        kinds,
        "#h": [channel(1)],
        "#e": [root, viewer],
        since: 5,
        include_aux: true,
        limit: 500,
      },
    ],
  ],
  [
    "a root fetch whose limit is not its count",
    batch.map((f) => (f.ids ? { ...f, limit: 2 } : f)),
  ],
  ["a null filter", [...batch.slice(0, 5), null]],
] as [string, unknown][])("rejects %s", (_name, filters) => {
  expect(isUnreadWindowBatch(filters)).toBe(false);
});
