import { ReadBudgetError, ReadError } from "./errors";
import { assert, describe, expect, it } from "vitest";
import type { RelayEvent } from "./events";
import {
  locate,
  SEEK_PAGE,
  SEEK_READS,
  SeekLimitError,
  type SeekRead,
} from "./history-seek";
import type { WindowCursor } from "./window";

const DAY = 86_400;
const T0 = 1_700_006_400; // A UTC midnight.

/** An in-memory NIP-CW channel window: `created_at DESC, id ASC` keyset pages. */
function relay(times: readonly number[]) {
  const rows = times
    .map(
      (created_at, index) =>
        ({
          id: index.toString(16).padStart(64, "0"),
          created_at,
          kind: 9,
          pubkey: "",
          tags: [],
          content: "",
          sig: "",
        }) as unknown as RelayEvent,
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const calls: { cursor: WindowCursor | null; full: boolean }[] = [];
  const read: SeekRead = async (cursor, full, limit = SEEK_PAGE) => {
    calls.push({ cursor, full });
    const after = cursor
      ? rows.filter(
          (row) =>
            row.created_at < cursor.createdAt ||
            (row.created_at === cursor.createdAt && row.id > cursor.eventId),
        )
      : rows;
    const events = after.slice(0, limit);
    const hasMore = after.length > limit;
    const last = events.at(-1);
    return {
      events,
      hasMore,
      cursor:
        hasMore && last
          ? { createdAt: last.created_at, eventId: last.id }
          : null,
    };
  };
  return { rows, read, calls };
}

const rowsOf = (located: Awaited<ReturnType<typeof locate>>) =>
  located.kind === "segment"
    ? located.page.events.map((event) => event.created_at)
    : [];

describe("locate", () => {
  it("fits on the first day probe", async () => {
    const hourly = Array.from({ length: 30 * 24 }, (_, i) => T0 + i * 3600);
    const { read, calls } = relay(hourly);
    const from = T0 + 10 * DAY;
    const located = await locate(read, from, T0 + 30 * DAY, true);
    expect(located.kind).toBe("segment");
    expect(rowsOf(located)).toContain(from);
    expect(rowsOf(located).some((at) => at < from)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gallops over empty days", async () => {
    const times = [
      ...Array.from({ length: 10 }, (_, i) => T0 + i * 60),
      ...Array.from({ length: 10 }, (_, i) => T0 + 20 * DAY + i * 60),
    ];
    const { read, calls } = relay(times);
    const located = await locate(read, T0 + 5 * DAY, T0 + 30 * DAY, true);
    expect(rowsOf(located)).toContain(T0 + 20 * DAY);
    expect(calls.length).toBeLessThanOrEqual(8);
  });

  it("binary searches a dense day", async () => {
    const from = T0 + 3 * DAY;
    const times = [
      ...Array.from({ length: 300 }, (_, i) => T0 + i * 600),
      ...Array.from({ length: 5000 }, (_, i) => from + 5 + i * 17),
    ];
    const { read, calls } = relay(times);
    const located = await locate(read, from, T0 + 10 * DAY, true);
    expect(rowsOf(located)).toContain(from + 5);
    expect(calls.length).toBeLessThanOrEqual(SEEK_READS);
  });

  it("returns newest when nothing is at or after from", async () => {
    const { read } = relay([T0, T0 + 60, T0 + 120]);
    await expect(locate(read, T0 + DAY, T0 + 3 * DAY, true)).resolves.toEqual({
      kind: "newest",
    });
  });

  it("finds the channel start without gallop", async () => {
    const span = 2 * 365 * DAY;
    const times = Array.from(
      { length: 3000 },
      (_, i) => T0 + Math.floor((i * span) / 3000),
    );
    const { read } = relay(times);
    const located = await locate(read, 0, T0 + span + DAY, false);
    expect(located).toMatchObject({ kind: "segment" });
    expect(rowsOf(located)).toContain(T0);
  });

  it("rejects a burst of more than a page in one second", async () => {
    const times = [
      ...Array.from({ length: 10 }, (_, i) => T0 + i),
      ...Array.from({ length: 450 }, () => T0 + DAY + 30),
    ];
    const { read } = relay(times);
    await expect(
      locate(read, T0 + DAY, T0 + 3 * DAY, true),
    ).rejects.toBeInstanceOf(SeekLimitError);
  });

  it("throws SeekLimitError past the read budget", async () => {
    let reads = 0;
    const overflow: SeekRead = async () => {
      reads++;
      // Every probe looks dense: rows at the far future, more beyond.
      return {
        events: [
          {
            id: "a".repeat(64),
            created_at: Number.MAX_SAFE_INTEGER,
            kind: 9,
          } as unknown as RelayEvent,
        ],
        hasMore: true,
        cursor: { createdAt: 1, eventId: "a".repeat(64) },
      };
    };
    await expect(
      locate(overflow, 0, Number.MAX_SAFE_INTEGER - 1, false),
    ).rejects.toBeInstanceOf(SeekLimitError);
    expect(reads).toBe(SEEK_READS);
  });

  it("reads bare probes and one full page", async () => {
    const hourly = Array.from({ length: 30 * 24 }, (_, i) => T0 + i * 3600);
    const { read, calls } = relay(hourly);
    await locate(read, T0 + 4 * DAY, T0 + 30 * DAY, true);
    expect(calls.slice(0, -1).every((call) => !call.full)).toBe(true);
    expect(calls.at(-1)?.full).toBe(true);
  });
});

it("starts composite fallback at the dense second after an empty gap", async () => {
  const burst = T0 + 2 * DAY;
  const { read } = relay([T0, ...Array.from({ length: 450 }, () => burst)]);
  const located = await locate(
    read,
    T0 + DAY,
    T0 + 3 * DAY,
    true,
    "f".repeat(64),
  );
  expect(rowsOf(located)).toContain(burst);
});

it.each([() => new ReadBudgetError(), () => "Relay response is too large"])(
  "counts reduced page attempts within the seek budget",
  async (failure) => {
    const limits: number[] = [];
    const read: SeekRead = async (_cursor, _full, limit = SEEK_PAGE) => {
      limits.push(limit);
      if (limit > 1) throw failure();
      return {
        events: [
          {
            kind: 9,
            created_at: Number.MAX_SAFE_INTEGER,
            id: "a".repeat(64),
          } as RelayEvent,
        ],
        hasMore: true,
        cursor: { createdAt: 1, eventId: "a".repeat(64) },
      };
    };
    await expect(
      locate(read, 0, Number.MAX_SAFE_INTEGER - 1, false),
    ).rejects.toBeInstanceOf(SeekLimitError);
    expect(limits.slice(0, 8)).toEqual([200, 100, 50, 25, 12, 6, 3, 1]);
    expect(limits).toHaveLength(SEEK_READS);
  },
);

it("does not retry malformed seek responses as oversized pages", async () => {
  let calls = 0;
  const error = new ReadError("invalid-response", "Invalid signed bounds");
  const read: SeekRead = async () => {
    calls++;
    throw error;
  };
  await expect(locate(read, T0, T0 + DAY, true)).rejects.toBe(error);
  expect(calls).toBe(1);
});

it("rechecks boundary coverage when auxiliary data shrinks the full read", async () => {
  const source = relay(Array.from({ length: 150 }, (_, i) => T0 + i));
  const read: SeekRead = async (cursor, full, limit = SEEK_PAGE) => {
    if (full && limit > 100) throw new ReadBudgetError();
    return source.read(cursor, full, limit);
  };
  const located = await locate(read, T0, T0 + 150, false);
  expect(rowsOf(located)).toContain(T0);
});

it("keeps future-dated dense-second rows above the sliding boundary", async () => {
  const { rows, read } = relay(Array.from({ length: 450 }, () => T0 + 60));
  const boundary = rows[350];
  assert.exists(boundary);
  const located = await locate(
    read,
    boundary.created_at,
    T0,
    true,
    boundary.id,
  );
  expect(located.kind).toBe("segment");
  if (located.kind !== "segment") return;
  expect(located.page.events.some((event) => event.id === boundary.id)).toBe(
    true,
  );
  expect(
    located.ceiling === null || located.ceiling >= boundary.created_at,
  ).toBe(true);
});

it("includes a future-dated head burst above a present sliding boundary", async () => {
  const { rows, read } = relay([
    T0,
    ...Array.from({ length: 450 }, () => T0 + 60),
  ]);
  const located = await locate(read, T0, T0, true, rows.at(-1)?.id);
  assert.equal(located.kind, "segment");
  if (located.kind !== "segment") return;
  assert.isNotNull(located.ceiling);
  expect(located.ceiling).toBeGreaterThan(T0 + 1);
  const next = await locate(
    read,
    located.ceiling ?? T0,
    T0,
    true,
    rows.at(-1)?.id,
  );
  expect(rowsOf(next)).toContain(T0 + 60);
});

it("reaches a retained segment in a ten-thousand-row second within the existing budget", async () => {
  const { rows, read, calls } = relay(Array.from({ length: 10000 }, () => T0));
  const boundary = rows[7600];
  assert.exists(boundary);
  const located = await locate(read, T0, T0 + DAY * 30, true, boundary.id);
  expect(located.kind).toBe("segment");
  if (located.kind !== "segment") return;
  expect(located.page.events.some((event) => event.id === boundary.id)).toBe(
    true,
  );
  expect(calls.length).toBeLessThanOrEqual(SEEK_READS);
});

it("reaches a deep composite boundary within the seek allowance", async () => {
  const { rows, read, calls } = relay(Array.from({ length: 12000 }, () => T0));
  const boundary = rows[9600];
  assert.exists(boundary);
  const located = await locate(read, T0, T0 + DAY, true, boundary.id);
  expect(located.kind).toBe("segment");
  if (located.kind !== "segment") return;
  expect(located.page.events.some((event) => event.id === boundary.id)).toBe(
    true,
  );
  expect(located.page.events.some((event) => event.id < boundary.id)).toBe(
    true,
  );
  expect(calls.length).toBeLessThanOrEqual(SEEK_READS);
});

it.each([1, 5, 200])(
  "keeps a contiguous composite segment with %i rows per page",
  async (pageSize) => {
    const source = relay(Array.from({ length: 1000 }, () => T0));
    const step = (1n << 256n) / 1001n;
    for (const [index, row] of source.rows.entries())
      row.id = (step * BigInt(index + 1)).toString(16).padStart(64, "0");
    const boundary = source.rows[800];
    assert.exists(boundary);
    const read: SeekRead = (cursor, full, limit) =>
      source.read(cursor, full, Math.min(limit ?? SEEK_PAGE, pageSize));
    const located = await locate(read, T0, T0 + DAY, true, boundary.id);
    assert.equal(located.kind, "segment");
    if (located.kind !== "segment") return;
    const ids = located.page.events.map((event) => event.id);
    const start = source.rows.findIndex((row) => row.id === ids[0]);
    expect(ids).toContain(boundary.id);
    expect(ids.some((id) => id < boundary.id)).toBe(true);
    expect(ids).toEqual(
      source.rows.slice(start, start + ids.length).map((row) => row.id),
    );
    expect(located.ceilingId).toBe(ids[0]);
    expect(source.calls.length).toBeLessThanOrEqual(SEEK_READS);
  },
);

it("reaches the oldest edge of a dense second from a timestamp-only boundary", async () => {
  const source = relay([T0 - 1, ...Array.from({ length: 12000 }, () => T0)]);
  const step = (1n << 256n) / 12002n;
  for (const [index, row] of source.rows.entries())
    row.id = (step * BigInt(index + 1)).toString(16).padStart(64, "0");
  const located = await locate(source.read, T0, T0 + DAY, true, "f".repeat(64));
  assert.equal(located.kind, "segment");
  if (located.kind !== "segment") return;
  expect(located.page.events.some((row) => row.created_at === T0)).toBe(true);
  expect(located.page.events.some((row) => row.created_at < T0)).toBe(true);
  expect(source.calls.length).toBeLessThanOrEqual(SEEK_READS);
});
