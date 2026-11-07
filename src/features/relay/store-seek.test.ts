import { getPublicKey } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import type { ReadFilter, RelayEvent } from "./events";
import { byteSize } from "./budget";
import { ReadError } from "./errors";
import {
  bounds,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const HOUR = 3600;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000;
const newestFirst = (a: RelayEvent, b: RelayEvent) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);

/** A session over an auto-answering relay holding `count` hourly messages in channel "c". */
function harness({
  count = 300,
  maxHistoryRows,
  maxHistoryBytes,
  spacing = HOUR,
  prepared,
  now,
  publicPreview = false,
  seed,
}: {
  count?: number;
  maxHistoryRows?: number;
  maxHistoryBytes?: number;
  spacing?: number;
  prepared?: boolean;
  now?: number;
  publicPreview?: boolean;
  seed?: number;
} = {}) {
  const makeKey = () => {
    if (seed === undefined) return keypair();
    const secret = new Uint8Array(32);
    secret[31] = ++seed;
    return { secret, pubkey: getPublicKey(secret) };
  };
  const relay = makeKey(),
    viewer = makeKey(),
    alice = makeKey();
  const history = Array.from({ length: count }, (_, i) =>
    message(alice, "c", `m${i}`, T0 + i * spacing),
  );
  const reads: ReadFilter[] = [];
  const gate: {
    hold?: Promise<void> | undefined;
    pageSize?: number;
    failHead?: boolean;
    probeFailure?: boolean;
    denied?: boolean;
    aux?: RelayEvent[];
    notices?: RelayEvent[];
    retryEveryOther?: boolean;
    retryTurn?: boolean;
  } = {};
  let live!: LiveCallbacks;
  const base = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    {
      ...base.transport,
      async query(filters, signal) {
        const filter = filters[0];
        if (publicPreview && filter?.kinds?.includes(39002))
          return new Promise<RelayEvent[]>(() => {});
        if (publicPreview && filter?.kinds?.includes(39000))
          return [metadata(relay, "c", "Public", T0, [["public"]])];
        if (filter?.kinds?.includes(40099))
          return (gate.notices ?? [])
            .filter(
              (event) =>
                filter.until === undefined ||
                event.created_at < filter.until ||
                (event.created_at === filter.until &&
                  event.id > (filter.before_id ?? "")),
            )
            .slice(0, filter.limit);
        if (filter?.ids)
          return history.filter((event) => filter.ids?.includes(event.id));
        if (!filter?.top_level) return [];
        reads.push(filter);
        if (gate.probeFailure)
          throw new Error("deliberately failed cursor probe");
        if (gate.retryEveryOther) {
          gate.retryTurn = !gate.retryTurn;
          if (gate.retryTurn)
            throw new ReadError("unavailable", "Transient read", 503);
        }
        await gate.hold;
        signal?.throwIfAborted();
        if (gate.denied) throw new ReadError("denied", "Access denied");
        if (gate.failHead && filter.until === undefined)
          throw new Error("offline");
        const cursor =
          filter.until !== undefined && filter.before_id
            ? { createdAt: filter.until, eventId: filter.before_id }
            : null;
        const ordered = [...history].sort(newestFirst);
        const after = cursor
          ? ordered.filter(
              (row) =>
                row.created_at < cursor.createdAt ||
                (row.created_at === cursor.createdAt &&
                  row.id > cursor.eventId),
            )
          : ordered;
        const limit = Math.min(filter.limit ?? 200, gate.pageSize ?? 200);
        const rows = after.slice(0, limit);
        const hasMore = after.length > limit;
        const last = rows.at(-1);
        return [
          ...rows,
          ...(filter.include_aux ? (gate.aux ?? []) : []),
          bounds(
            relay,
            "c",
            cursor ? `${cursor.createdAt}:${cursor.eventId}` : "head",
            {
              has_more: hasMore,
              next_cursor:
                hasMore && last
                  ? { created_at: last.created_at, id: last.id }
                  : null,
            },
          ),
        ];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      now: () => now ?? (T0 + count * HOUR) * 1000,
      ...(maxHistoryRows ? { maxHistoryRows } : {}),
      ...(maxHistoryBytes ? { maxHistoryBytes } : {}),
      ...(prepared ? { prepared } : {}),
    },
  );
  const channels = owner.session.channels;
  assert.exists(channels.seek);
  assert.exists(channels.loadNewer);
  assert.exists(channels.attach);
  const window = () => channels.window("c");
  const times = () => window().rows.map((row) => row.createdAt);
  const open = async () => {
    if (publicPreview) await channels.resolve?.(["c"]);
    else
      live.receive([
        roster(relay, "c", [viewer.pubkey]),
        metadata(relay, "c", "C"),
      ]);
    channels.ensure("c");
    await vi.waitFor(() => expect(window().status).toBe("ready"));
  };
  const seek = (from: number, signal = new AbortController().signal) =>
    (channels.seek as NonNullable<typeof channels.seek>)("c", from, signal);
  return {
    relay,
    viewer,
    alice,
    owner,
    channels,
    history,
    reads,
    gate,
    get live() {
      return live;
    },
    window,
    times,
    open,
    seek,
  };
}

let current: ReturnType<typeof harness> | undefined;
const setup = (options?: Parameters<typeof harness>[0]) => {
  current = harness(options);
  return current;
};
afterEach(() => {
  current?.owner.dispose();
  current = undefined;
});

it("seek installs a segment and resolves the first row at or after from", async () => {
  const h = setup();
  await h.open();
  const from = T0 + 5 * DAY + 1;
  const id = await h.seek(from);
  expect(id).toBe(h.history[5 * 24 + 1]?.id);
  expect(h.window().hasNewer).toBe(true);
  expect(h.times()[0]).toBeLessThan(from);
  expect(h.times()).not.toContain(T0 + 299 * HOUR);
});

it("seek resolves the newest row when nothing is at or after from", async () => {
  const h = setup();
  await h.open();
  const id = await h.seek(T0 + 299 * HOUR + 1);
  expect(id).toBe(h.history[299]?.id);
  expect(h.window().hasNewer).toBeFalsy();
});

it("seek uses held rows without reading", async () => {
  const h = setup();
  await h.open();
  const reads = h.reads.length;
  const id = await h.seek(T0 + 295 * HOUR);
  expect(id).toBe(h.history[295]?.id);
  expect(h.reads).toHaveLength(reads);
});

it("an aborted seek leaves the window unchanged", async () => {
  const h = setup();
  await h.open();
  const before = h.window();
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const pending = h.seek(T0 + DAY, controller.signal);
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(h.window()).toBe(before);
});

it("loadOlder pages a detached window from its older cursor", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 9 * DAY);
  const oldest = h.times()[0];
  assert.exists(oldest);
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.times()[0]).toBeLessThan(oldest));
  expect(h.reads.at(-1)).toMatchObject({ until: oldest });
  expect(h.window().hasNewer).toBe(true);
});

it("loadNewer extends the segment and reattaches at the head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 2 * DAY);
  const newest = () => h.times().at(-1) ?? 0;
  for (let step = 0; h.window().hasNewer && step < 20; step++) {
    const before = newest();
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(newest()).toBeGreaterThan(before);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(newest()).toBe(T0 + 299 * HOUR);
  // Contiguous: one row per hour from the segment's oldest to the head.
  const times = h.times();
  expect(
    times.every((at, i) => i === 0 || at - (times[i - 1] ?? 0) === HOUR),
  ).toBe(true);
});

it.each([
  { maxHistoryRows: 40 },
  { maxHistoryBytes: 12_000 },
  { maxHistoryRows: 40, spacing: 0 },
])(
  "slides through older history and back to the head within %j",
  async (limit) => {
    const h = setup({ count: 100, ...limit });
    await h.open();
    const ordered = [...h.history].sort(newestFirst).reverse();
    const seen = new Set(h.window().rows.map((row) => row.id));
    const bounded = () => {
      const ids = new Set(h.window().rows.map((row) => row.id));
      expect(ids.size).toBeLessThanOrEqual(limit.maxHistoryRows ?? 2400);
      expect(
        byteSize(h.history.filter((event) => ids.has(event.id))),
      ).toBeLessThanOrEqual(limit.maxHistoryBytes ?? 8 * 1024 * 1024);
    };
    for (let step = 0; h.window().hasMore && step < 10; step++) {
      const before = h.window().rows.map((row) => row.id);
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
      expect(h.window().historyLimited).toBeFalsy();
      expect(h.window().rows.map((row) => row.id)).not.toEqual(before);
      for (const row of h.window().rows) seen.add(row.id);
      bounded();
    }
    expect(h.window().hasMore).toBe(false);
    expect(seen.size).toBe(100);
    expect(h.window().rows.map((row) => row.id)).toContain(ordered[0]?.id);
    expect(h.window().hasNewer).toBe(true);
    const evicted = ordered.at(-1);
    assert.exists(evicted);
    h.live.receive([evicted]);
    expect(h.window().rows.map((row) => row.id)).not.toContain(evicted.id);
    const forward = new Set(h.window().rows.map((row) => row.id));
    for (let step = 0; h.window().hasNewer && step < 10; step++) {
      const before = h.window().rows.map((row) => row.id);
      h.channels.loadNewer?.("c");
      await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
      expect([
        h.window().rows.map((row) => row.id),
        !!h.window().hasNewer,
      ]).not.toEqual([before, true]);
      for (const row of h.window().rows) forward.add(row.id);
      bounded();
    }
    expect(h.window().hasNewer).toBeFalsy();
    expect(forward.size).toBe(100);
    expect(h.window().rows.map((row) => row.id)).toContain(evicted.id);
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    expect(h.window().historyLimited).toBeFalsy();
    bounded();
  },
);

it("keeps both retained messages at a sliding boundary's second", async () => {
  const h = setup({ count: 60, maxHistoryRows: 40, spacing: 0 });
  await h.open();
  for (let page = 0; page < 2; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = [...h.history].sort(newestFirst).slice(20);
  const [boundary, neighbor] = retained;
  assert.exists(boundary);
  assert.exists(neighbor);
  expect(boundary.created_at).toBe(neighbor.created_at);
  expect(h.window().rows.map((row) => row.id)).toEqual(
    expect.arrayContaining([boundary.id, neighbor.id]),
  );
  expect(h.window().rows).toHaveLength(40);
  expect(h.window().hasNewer).toBe(true);
});

it("loadNewer trims the oldest rows past maxHistoryRows", async () => {
  const h = setup({ maxHistoryRows: 100 });
  await h.open();
  await h.seek(T0 + DAY);
  for (let step = 0; h.window().rows.length < 100 && step < 10; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  }
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.length).toBeLessThanOrEqual(100);
  expect(h.window().hasMore).toBe(true);
  const oldest = h.window().rows[0];
  assert.exists(oldest);
  h.channels.loadOlder("c");
  await vi.waitFor(() =>
    expect(h.reads.at(-1)).toMatchObject({
      until: oldest.createdAt,
      before_id: oldest.id,
    }),
  );
});

it("accept keeps live rows above a detached ceiling out of the window", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const held = h.window().rows.at(-1);
  assert.exists(held);
  const fresh = message(h.alice, "c", "fresh", T0 + 300 * HOUR);
  h.live.receive([fresh]);
  expect(h.window().rows.map((row) => row.id)).not.toContain(fresh.id);
  h.live.receive([
    signed(h.alice, {
      kind: 7,
      content: "+",
      created_at: T0 + 300 * HOUR,
      tags: [
        ["h", "c"],
        ["e", held.id],
        ["p", held.authorId],
      ],
    }),
  ]);
  await vi.waitFor(() =>
    expect(h.window().rows.at(-1)?.reactions.length).toBe(1),
  );
});

it("catchUp returns a detached window to its head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  await vi.waitFor(() => expect(h.times().at(-1)).toBe(T0 + 299 * HOUR));
  expect(h.times()[0]).toBeGreaterThan(T0 + 3 * DAY);
});

it("a failed catch-up keeps the detached segment", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const segment = h.times();
  h.gate.failHead = true;
  const reads = h.reads.length;
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.reads.slice(reads).some((read) => read.until === undefined)).toBe(
      true,
    ),
  );
  await vi.waitFor(() => expect(h.window().error).toBeDefined());
  expect(h.times()).toEqual(segment);
  expect(h.window().hasNewer).toBe(true);
});

it("catch-up cancels a detached window's newer page", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadNewer?.("c");
  expect(h.window().loadingNewer).toBe(true);
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.times().at(-1)).toBe(T0 + 299 * HOUR));
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.times().at(-1)).toBe(T0 + 299 * HOUR);
});

it("a detached segment does not become the channel preview", async () => {
  const h = setup();
  await h.open();
  const preview = () =>
    h.channels.list().channels.find((channel) => channel.id === "c")?.preview;
  await vi.waitFor(() => expect(preview()).toBe("m299"));
  await h.seek(T0 + 3 * DAY);
  expect(preview()).toBe("m299");
  h.channels.attach?.("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  expect(preview()).toBe("m299");
});

it("live messages move the channel preview while detached", async () => {
  const h = setup();
  await h.open();
  const preview = () =>
    h.channels.list().channels.find((channel) => channel.id === "c")?.preview;
  await vi.waitFor(() => expect(preview()).toBe("m299"));
  await h.seek(T0 + 3 * DAY);
  h.live.receive([message(h.alice, "c", "fresh", T0 + 300 * HOUR)]);
  await vi.waitFor(() => expect(preview()).toBe("fresh"));
  expect(h.window().hasNewer).toBe(true);
});

it.each([
  ["a page", false],
  ["a prepared head", true],
])(
  "a live row that lands while attach reads %s is kept",
  async (_, prepared) => {
    const h = setup({ prepared });
    await h.open();
    await h.seek(T0 + 3 * DAY);
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    const reads = h.reads.length;
    h.channels.attach?.("c");
    // The relay answered before `fresh` was published; it arrives live.
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
    const fresh = message(h.alice, "c", "fresh", T0 + 299 * HOUR + 1800);
    h.live.receive([fresh]);
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
    expect(h.window().rows.map((row) => row.id)).toContain(fresh.id);
  },
);

it("a live row that lands while the last newer page loads is kept", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const fresh = message(h.alice, "c", "fresh", T0 + 299 * HOUR + 1800);
  for (let page = 0; page < 10 && h.window().hasNewer; page++) {
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    h.channels.loadNewer?.("c");
    // The relay answered before `fresh` was published; it arrives live.
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(0));
    h.live.receive([fresh]);
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.window().rows.map((row) => row.id)).toContain(fresh.id);
});

it("attach cancels an older page before it can detach the head window", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().rows).toHaveLength(40));
  expect(h.window().hasNewer).toBeFalsy();
  const retained = h.window().rows.map((row) => row.id);
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const before = h.reads.length;
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
    expect(h.window().loadingOlder).toBe(true);
    h.channels.attach?.("c");
  } finally {
    h.gate.hold = undefined;
    release();
  }
  await vi.waitFor(() => {
    expect(h.window().loadingOlder).toBe(false);
    expect(h.window().refreshing).toBeFalsy();
  });
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.window().rows.at(-1)?.id).toBe(h.history.at(-1)?.id);
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
});

it("attach replaces the segment with the head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  h.channels.attach?.("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  expect(h.times().at(-1)).toBe(T0 + 299 * HOUR);
  expect(h.times()[0]).toBeGreaterThan(T0 + 3 * DAY);
});

it("rows received before a seek stay out of its segment", async () => {
  const h = setup();
  await h.open();
  const fresh = message(h.alice, "c", "fresh", T0 + 300 * HOUR);
  h.live.receive([fresh]);
  await vi.waitFor(() =>
    expect(h.window().rows.map((row) => row.id)).toContain(fresh.id),
  );
  await h.seek(T0 + 3 * DAY);
  expect(h.window().rows.map((row) => row.id)).not.toContain(fresh.id);
});

it("live rows do not crowd a detached segment out of the history budget", async () => {
  const h = setup({ maxHistoryRows: 250 });
  await h.open();
  await h.seek(T0 + 10 * DAY);
  expect(h.window().rows.length).toBe(200);
  const oldest = h.window().rows[0]?.id;
  h.live.receive(
    Array.from({ length: 60 }, (_, i) =>
      message(h.alice, "c", `fresh${i}`, T0 + 300 * HOUR + i),
    ),
  );
  expect(h.window().rows[0]?.id).toBe(oldest);
});

it("keeps the joining row when live eviction overlaps an older page", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const joining = h.window().rows[0];
  assert.exists(joining);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  h.live.receive([message(h.alice, "c", "fresh", T0 + 100 * HOUR)]);
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toContain(joining.id);
});

it("preserves a slid reader when its route reconnects", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const retained = h.window().rows.map((row) => row.id);
  const reads = h.reads.length;
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
});

it("purges retained channel rows when forward paging is denied", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  for (let step = 0; step < 3; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().rows.length).toBeGreaterThan(0);
  expect(h.window().hasNewer).toBe(true);
  h.gate.denied = true;
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().error).toBeDefined());
  expect(h.window().rows).toEqual([]);
  expect(h.window().status).toBe("error");
  expect(h.window().loadingNewer).toBeFalsy();
  h.gate.denied = false;
  h.live.receive([roster(h.relay, "c", [h.viewer.pubkey], T0 + 1)]);
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  expect(h.window().status).toBe("ready");
  expect(h.window().rows.at(-1)?.id).toBe(h.history.at(-1)?.id);
  expect(h.window().hasNewer).toBeFalsy();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.times()[0]).toBe(T0 + 60 * HOUR);
});

it("releases cancelled forward paging after reconnect without losing the reader", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  for (let i = 0; i < 3; i++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = h.window().rows.map((row) => row.id);
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = h.reads.length;
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
  expect(h.window().loadingNewer).toBe(true);
  try {
    h.live.state({ status: "retrying", routes: [] });
  } finally {
    h.gate.hold = undefined;
    release();
  }
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().error).toBeUndefined();
  expect(h.window().rows.map((row) => row.id)).not.toEqual(retained);
});
it("releases cancelled older paging after reconnect without losing the reader", async () => {
  const h = setup({ count: 500, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  for (let i = 0; i < 12; i++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = h.window().rows.map((row) => row.id);
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = h.reads.length;
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
  expect(h.window().loadingOlder).toBe(true);
  try {
    h.live.state({ status: "retrying", routes: [] });
  } finally {
    h.gate.hold = undefined;
    release();
  }
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBeFalsy());
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBeFalsy());
  expect(h.window().error).toBeUndefined();
  expect(h.window().rows.map((row) => row.id)).not.toEqual(retained);
});

it("loads newer across a sliding boundary with more than a page in one second", async () => {
  const h = setup({ count: 300, spacing: 0, maxHistoryRows: 40 });
  await h.open();
  for (let step = 0; h.window().hasMore && step < 20; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().hasMore).toBe(false);
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasNewer && step < 30; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(h.window().error).toBeUndefined();
    expect(h.window().rows.length).toBeLessThanOrEqual(40);
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(seen.size).toBe(300);
});

it.each(["older", "newer"])(
  "keeps deleted reaction overlays while paging %s",
  async (direction) => {
    const h = setup({ count: 100, maxHistoryRows: 40 });
    await h.open();
    const target = h.history[direction === "older" ? 60 : 90];
    assert.exists(target);
    const reaction = signed(h.alice, {
      kind: 7,
      content: "+",
      created_at: T0 + 101 * HOUR,
      tags: [
        ["h", "c"],
        ["e", target.id],
        ["p", target.pubkey],
      ],
    });
    const deletion = signed(h.alice, {
      kind: 5,
      content: "",
      created_at: T0 + 102 * HOUR,
      tags: [
        ["h", "c"],
        ["e", reaction.id],
      ],
    });
    h.gate.aux = [deletion, reaction];
    for (let i = 0; i < 2; i++) {
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    }
    if (direction === "newer") {
      h.channels.loadNewer?.("c");
      await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    }
    const row = h.window().rows.find((row) => row.id === target.id);
    assert.exists(row);
    expect(row.reactions).toHaveLength(0);
  },
);

it.each([false, true])(
  "preserves a slid segment beyond reconnect catch-up coverage after forward paging: %s",
  async (forward) => {
    const h = setup({ count: 200, spacing: 2 * HOUR, maxHistoryRows: 40 });
    await h.open();
    h.live.state({ status: "connected", routes: [] });
    h.live.established("c");
    await vi.waitFor(() =>
      expect(h.owner.session.live?.snapshot().heads).toContainEqual({
        channelId: "c",
        state: "verified",
      }),
    );
    for (let step = 0; h.window().hasMore && step < 100; step++) {
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false), {
        interval: 1,
      });
    }
    expect(h.window().hasMore).toBe(false);
    if (forward) {
      h.channels.loadNewer?.("c");
      await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    }
    const retained = h.window().rows.map((row) => row.id);
    h.live.state({ status: "connected", routes: [] });
    h.live.state({ status: "retrying", routes: [] });
    expect(h.window().freshness).toBe("cached");
    h.live.state({ status: "connected", routes: [] });
    h.live.established("c");
    await vi.waitFor(() =>
      expect(h.owner.session.live?.snapshot().heads).toContainEqual({
        channelId: "c",
        state: "verified",
      }),
    );
    expect(h.window().freshness).toBe("cached");
    expect(h.window().rows.map((row) => row.id)).toEqual(retained);
    h.channels.attach?.("c");
    await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
    expect(h.window().rows.at(-1)?.id).toBe(h.history.at(-1)?.id);
  },
);

it("keeps unrevalidated retained history cached after an older page succeeds", async () => {
  const h = setup({ count: 200, spacing: 2 * HOUR, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  for (let step = 0; step < 8; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = h.window().rows.map((row) => row.id);
  expect(h.window().hasMore).toBe(true);
  h.live.state({ status: "retrying", routes: [] });
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.owner.session.live?.snapshot().heads).toContainEqual({
      channelId: "c",
      state: "verified",
    }),
  );
  expect(h.window().freshness).toBe("cached");
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.some((row) => retained.includes(row.id))).toBe(true);
  expect(h.window().freshness).toBe("cached");
});

it("traverses omitted dense-second pages when a newer page fits the allowance", async () => {
  const h = setup({ count: 1000, spacing: 0, maxHistoryRows: 600 });
  await h.open();
  for (let step = 0; h.window().hasMore && step < 100; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false), {
      interval: 1,
    });
  }
  expect(h.window().hasMore).toBe(false);
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasNewer && step < 100; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy(), {
      interval: 1,
    });
    expect(h.window().error).toBeUndefined();
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(seen.size).toBe(1000);
});

it("continues membership-notice descent after the history window slides", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  const notice = (time: number, target: string) =>
    signed(h.relay, {
      kind: 40099,
      created_at: time,
      tags: [["h", "c"]],
      content: JSON.stringify({
        type: "member_joined",
        actor: h.alice.pubkey,
        target,
      }),
    });
  const target = notice(T0 + 45 * HOUR, h.alice.pubkey);
  h.gate.notices = [
    ...Array.from({ length: 500 }, (_, i) =>
      notice(T0 + 50 * HOUR, i.toString(16).padStart(64, "0")),
    ),
    target,
  ].sort(newestFirst);
  await h.open();
  for (let step = 0; step < 2; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().hasNewer).toBe(true);
  await vi.waitFor(() =>
    expect(h.window().rows.map((row) => row.id)).toContain(target.id),
  );
});

it("does not resurrect a joining message deleted and evicted during an older read", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const joining = h.window().rows[0];
  assert.exists(joining);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      created_at: T0 + 101 * HOUR,
      tags: [
        ["h", "c"],
        ["e", joining.id],
      ],
      content: "",
    }),
  ]);
  h.live.receive(
    Array.from({ length: 60 }, (_, i) =>
      message(h.alice, "c", `new${i}`, T0 + 102 * HOUR + i),
    ),
  );
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(
    h.window().rows.find((row) => row.id === joining.id)?.content,
  ).not.toBe(joining.content);
});

it("retains a rendered anchor that fits with shared-second older rows", async () => {
  const h = setup({ count: 60, maxHistoryRows: 40, spacing: 0 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const anchor = h.window().rows[20]?.id;
  assert.exists(anchor);
  h.channels.loadOlder("c", anchor);
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toContain(anchor);
  const nextAnchor = h.window().rows.at(-1)?.id;
  assert.exists(nextAnchor);
  h.channels.loadOlder("c", nextAnchor);
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toContain(nextAnchor);
  expect(h.window().hasMore).toBe(false);
});

it("retains a rendered anchor that fits with shared-second newer rows", async () => {
  const h = setup({ count: 60, maxHistoryRows: 40, spacing: 0 });
  await h.open();
  for (let step = 0; h.window().hasMore && step < 5; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const anchor = h.window().rows[19]?.id;
  assert.exists(anchor);
  h.channels.loadNewer?.("c", anchor);
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.map((row) => row.id)).toContain(anchor);
  const nextAnchor = h.window().rows[0]?.id;
  assert.exists(nextAnchor);
  for (let step = 0; h.window().hasNewer && step < 4; step++) {
    h.channels.loadNewer?.("c", nextAnchor);
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(h.window().rows.map((row) => row.id)).toContain(nextAnchor);
  }
  expect(h.window().hasNewer).toBeFalsy();
});

it("hands off a rendered anchor when preserving it would repeat the older cursor", async () => {
  const h = setup({ count: 0 });
  const secret = new Uint8Array(32).fill(1);
  const alice = { secret, pubkey: getPublicKey(secret) };
  const payload = "x".repeat(128 * 1024);
  const tags = [
    ["ms", "100"],
    ["metadata", payload],
  ];
  const rows = Array.from({ length: 79 }, (_, i) =>
    message(alice, "c", `dense${i}`, T0, tags),
  );
  const firstId = [...rows].sort(newestFirst)[0]?.id;
  assert.exists(firstId);
  // This signed ms=0 row sorts first both in rendered order and relay ID order.
  const anchor = message(alice, "c", "anchor3", T0, [
    ["ms", "0"],
    ["metadata", payload],
  ]);
  expect(anchor.id < firstId).toBe(true);
  h.history.push(...rows, anchor);
  await h.open();
  expect(h.window().rows[0]?.id).toBe(anchor.id);
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasMore && step < 5; step++) {
    const before = h.window().rows.map((row) => row.id);
    h.channels.loadOlder("c", h.window().rows[0]?.id);
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    expect(h.window().rows.map((row) => row.id)).not.toEqual(before);
    for (const row of h.window().rows) seen.add(row.id);
    const ids = new Set(h.window().rows.map((row) => row.id));
    expect(
      byteSize(h.history.filter((event) => ids.has(event.id))),
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
  }
  expect(h.window().hasMore).toBe(false);
  expect(seen.size).toBe(80);
  for (let step = 0; h.window().hasNewer && step < 5; step++) {
    h.channels.loadNewer?.("c", h.window().rows.at(-1)?.id);
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(h.window().error).toBeUndefined();
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.window().rows.map((row) => row.id)).toContain(anchor.id);
});

it("preserves adjacent newer rows when handing off a byte-heavy anchor", async () => {
  const h = setup({
    count: 400,
    spacing: 0,
    maxHistoryRows: 300,
    maxHistoryBytes: 240_000,
  });
  await h.open();
  for (let step = 0; step < 12; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const ordered = [...h.history].sort(newestFirst);
  const retained = new Set(h.window().rows.map((row) => row.id));
  const oldest = Math.max(
    ...ordered.map((event, index) => (retained.has(event.id) ? index : -1)),
  );
  const target = ordered[oldest + 20];
  assert.exists(target);
  const reaction = signed(h.alice, {
    kind: 7,
    content: "+",
    created_at: T0 + 401 * HOUR,
    tags: [
      ["h", "c"],
      ["e", target.id],
      ["metadata", "x".repeat(220_000)],
    ],
  });
  h.gate.aux = [reaction];
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toContain(target.id);
  h.gate.aux = [];
  const initial = new Set(h.window().rows.map((row) => row.id));
  const from = ordered.findIndex((event) => initial.has(event.id));
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasNewer && step < 20; step++) {
    h.channels.loadNewer?.(
      "c",
      step === 0 ? target.id : h.window().rows[0]?.id,
    );
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(h.window().error).toBeUndefined();
    for (const row of h.window().rows) seen.add(row.id);
    const ids = new Set(h.window().rows.map((row) => row.id));
    expect(
      byteSize(
        [...h.history, reaction].filter(
          (event) =>
            ids.has(event.id) ||
            (event.id === reaction.id && ids.has(target.id)),
        ),
      ),
    ).toBeLessThanOrEqual(240_000);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(
    ordered
      .slice(0, from)
      .filter((event) => !seen.has(event.id))
      .map((event) => event.content),
  ).toEqual([]);
});

it("keeps joining reactions accepted after their root leaves the live window", async () => {
  const h = setup({ count: 100, maxHistoryRows: 60 });
  await h.open();
  const target = h.history[80];
  assert.exists(target);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  const reaction = signed(h.alice, {
    kind: 7,
    content: "+",
    created_at: T0 + 101 * HOUR,
    tags: [
      ["h", "c"],
      ["e", target.id],
      ["p", target.pubkey],
    ],
  });
  h.live.receive([reaction]);
  const live = Array.from({ length: 81 }, (_, i) =>
    message(h.alice, "c", `live${i}`, T0 + (100 + i) * HOUR),
  );
  h.history.push(...live);
  h.live.receive(live);
  expect(h.window().rows.some((row) => row.id === target.id)).toBe(false);
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const restored = h.window().rows.find((row) => row.id === target.id);
  assert.exists(restored);
  expect(restored.reactions).toHaveLength(1);
});

it("retains a forward boundary when buffered live rows do not fit the final page", async () => {
  const h = setup({ count: 60, maxHistoryRows: 40 });
  await h.open();
  for (let page = 0; page < 2; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadNewer?.("c", h.window().rows[20]?.id);
  const live = message(h.alice, "c", "buffered", T0 + 60 * HOUR);
  h.live.receive([live]);
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  h.history.push(live);
  for (let step = 0; h.window().hasNewer && step < 8; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  }
  expect(h.window().rows.map((row) => row.id)).toContain(live.id);
});

it("does not restore a joining root deleted after live eviction", async () => {
  const h = setup({ count: 100, maxHistoryRows: 60 });
  await h.open();
  const target = h.history[80];
  assert.exists(target);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  h.live.receive(
    Array.from({ length: 70 }, (_, i) =>
      message(h.alice, "c", `evict${i}`, T0 + (100 + i) * HOUR, [
        ["metadata", "x".repeat(150000)],
      ]),
    ),
  );
  expect(h.window().rows.some((row) => row.id === target.id)).toBe(false);
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      content: "",
      created_at: T0 + 801 * HOUR,
      tags: [
        ["h", "c"],
        ["e", target.id],
      ],
    }),
  ]);
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.find((row) => row.id === target.id)?.content).not.toBe(
    target.content,
  );
});

it("does not commit a rejected oversized older page's bounds", async () => {
  const h = setup({ count: 60, maxHistoryBytes: 12000 });
  await h.open();
  const retained = h.window().rows.map((row) => row.id);
  const oldest = Math.min(...h.times());
  h.history.splice(
    0,
    h.history.findIndex((event) => event.created_at === oldest),
  );
  h.history.push(
    message(h.alice, "c", `oversize${"x".repeat(20000)}`, oldest - 1),
  );
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
  expect(h.window().hasNewer).toBeFalsy();
});

it("preserves joining continuity when live traffic evicts the newer tail", async () => {
  const h = setup({ count: 100, maxHistoryRows: 60 });
  await h.open();
  const anchor = h.history[99]?.id;
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c", anchor);
  const fresh = Array.from({ length: 61 }, (_, i) =>
    message(h.alice, "c", `live${i}`, T0 + (100 + i) * HOUR),
  );
  h.history.push(...fresh);
  h.live.receive(fresh);
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasNewer && step < 15; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(
    fresh.filter((event) => !seen.has(event.id)).map((event) => event.content),
  ).toEqual([]);
});

it("recovers overlap roots that a large live reaction evicted below the forward ceiling", async () => {
  const h = setup({ count: 100, maxHistoryBytes: 8 * 1024 * 1024 });
  for (let i = 0; i < h.history.length; i++)
    h.history[i] = message(h.alice, "c", `m${i}`, T0 + i * HOUR, [
      ["metadata", "x".repeat(128 * 1024)],
    ]);
  await h.open();
  for (let page = 0; !h.window().hasNewer && page < 8; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().hasNewer).toBe(true);
  const expected = h.window().rows.map((row) => row.id);
  const target = h.window().rows[0];
  assert.exists(target);
  const reaction = signed(h.alice, {
    kind: 7,
    created_at: T0 + 101 * HOUR,
    content: "+",
    tags: [
      ["h", "c"],
      ["e", target.id],
      ["metadata", "x".repeat(768 * 1024)],
    ],
  });
  h.gate.aux = [reaction];
  h.live.receive([reaction]);
  const seen = new Set(h.window().rows.map((row) => row.id));
  expect(expected.some((id) => !seen.has(id))).toBe(true);
  for (let step = 0; h.window().hasNewer && step < 30; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(expected.filter((id) => !seen.has(id))).toEqual([]);
});

it("revalidates a retained cached target by its composite boundary in a dense second", async () => {
  const h = setup({ count: 450, spacing: 0 });
  await h.open();
  const target = h.window().rows[10];
  assert.exists(target);
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  expect(h.window().freshness).toBe("cached");
  await h.channels.seek?.(
    "c",
    target.createdAt,
    new AbortController().signal,
    target.id,
  );
  expect(h.window().freshness).toBe("verified");
  expect(h.window().rows.some((row) => row.id === target.id)).toBe(true);
});

it("preserves contact-only deletion authority in the joining backup", async () => {
  const h = setup({ count: 100, maxHistoryRows: 60 });
  const target = message(h.relay, "c", "relay contact", T0 + 80 * HOUR, [
    ["actor", h.alice.pubkey],
  ]);
  h.history[80] = target;
  await h.open();
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      content: "",
      created_at: T0 + 101 * HOUR,
      tags: [
        ["h", "c"],
        ["e", target.id],
      ],
    }),
  ]);
  expect(h.window().rows.find((row) => row.id === target.id)?.content).toBe(
    target.content,
  );
  h.live.receive(
    Array.from({ length: 81 }, (_, i) =>
      message(h.alice, "c", `evict${i}`, T0 + (102 + i) * HOUR),
    ),
  );
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.find((row) => row.id === target.id)?.content).toBe(
    target.content,
  );
});

it("settles the live head separately from an unreachable sliding reader on reopen", async () => {
  const h = setup({ count: 300, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.owner.session.live?.snapshot().heads).toContainEqual({
      channelId: "c",
      state: "verified",
    }),
  );
  for (let page = 0; page < 10; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = h.window().rows.map((row) => row.id);
  const before = h.reads.length;
  h.live.state({ status: "retrying", routes: [] });
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.owner.session.live?.snapshot().heads).toContainEqual({
      channelId: "c",
      state: "verified",
    }),
  );
  expect(h.reads.length - before).toBe(1);
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
  expect(h.window().freshness).toBe("cached");
  h.channels.ensure("c");
  await Promise.resolve();
  expect(h.reads.length - before).toBe(1);
});

it("releases forward paging when another channel loses access", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.live.receive([roster(h.relay, "other", [h.viewer.pubkey], T0)]);
  for (let page = 0; page < 2; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadNewer?.("c");
  expect(h.window().loadingNewer).toBe(true);
  h.live.receive([roster(h.relay, "other", [], T0 + 1)]);
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().error).toBeUndefined();
});

it("keeps isolated exact reads from advancing the older cursor across unread history", async () => {
  const h = setup({ count: 100, maxHistoryBytes: 12000 });
  const isolated = message(h.alice, "c", `isolated${"x".repeat(5000)}`, T0);
  h.history[0] = isolated;
  await h.open();
  const oldest = Math.min(...h.times());
  await h.owner.session.read([{ ids: [isolated.id], limit: 1 }]);
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.reads.at(-1)?.until).toBe(oldest);
  expect(
    h.window().rows.some((row) => row.createdAt < oldest && row.createdAt > T0),
  ).toBe(true);
});

it("admits live arrivals beyond the loaded composite cursor within its first second", async () => {
  const h = setup({ count: 450, spacing: 0 });
  await h.open();
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = h.reads.length;
  h.channels.loadOlder("c");
  try {
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
    const cursor = h.reads.at(-1)?.before_id;
    assert.exists(cursor);
    let event!: RelayEvent;
    for (let nonce = 0; !event || event.id <= cursor; nonce++)
      event = message(h.alice, "c", `delayed live ${nonce}`, T0);
    h.history.push(event);
    await h.owner.session.read([{ ids: [event.id], limit: 1 }]);
    expect(h.window().rows.some((row) => row.id === event.id)).toBe(false);
    h.live.receive([event], { channelId: "c", phase: "live" });
    expect(h.window().rows.some((row) => row.id === event.id)).toBe(true);
  } finally {
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
});

it("keeps detached live boundary arrivals from advancing the cursor across unread same-second roots", async () => {
  const h = setup({ count: 450, spacing: 0, maxHistoryBytes: 12000 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().hasNewer).toBe(true);
  const cursor = h
    .window()
    .rows.map((row) => row.id)
    .sort()
    .at(-1);
  assert.exists(cursor);
  let event!: RelayEvent;
  for (let nonce = 0; !event || event.id <= cursor; nonce++)
    event = message(h.alice, "c", `large live ${nonce}${"x".repeat(7000)}`, T0);
  h.live.receive([event], { channelId: "c", phase: "live" });
  expect(h.window().rows.some((row) => row.id === event.id)).toBe(true);
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.reads.at(-1)?.before_id).toBe(cursor);
});

it("counts actual transport retries inside the seek read allowance", async () => {
  const h = setup({ count: 300, now: 8e15 });
  await h.open();
  const before = h.reads.length;
  vi.useFakeTimers();
  h.gate.retryEveryOther = true;
  const seek = h.seek(0).catch((error) => error);
  try {
    await vi.runAllTimersAsync();
    await seek;
    expect(h.reads.length - before).toBeLessThanOrEqual(40);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects an oversized forward row without replacing the committed window", async () => {
  const h = setup({ count: 100, maxHistoryBytes: 12000 });
  await h.open();
  for (let page = 0; page < 3; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = h.window().rows.map((row) => row.id);
  const newest = Math.max(...h.times());
  const index = h.history.findIndex(
    (event) => event.created_at === newest + HOUR,
  );
  expect(index).toBeGreaterThanOrEqual(0);
  h.history[index] = message(h.alice, "c", "x".repeat(20000), newest + HOUR);
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
  expect(h.window().errorDirection).toBe("newer");
});

it("cancels a joining snapshot whose accepted overlays exceed its byte allowance", async () => {
  const h = setup({ count: 100, maxHistoryBytes: 12000 });
  await h.open();
  const target = h.window().rows[0];
  assert.exists(target);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  const reaction = signed(h.alice, {
    kind: 7,
    content: "+",
    created_at: T0 + 101 * HOUR,
    tags: [
      ["h", "c"],
      ["e", target.id],
      ["metadata", "x".repeat(12000)],
    ],
  });
  try {
    h.live.receive([reaction]);
    expect(h.window().loadingOlder).toBe(false);
    expect(h.window().errorDirection).toBe("older");
  } finally {
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
});

it("does not choose an isolated live root as a clipped older page cursor", async () => {
  const h = setup({ count: 160, spacing: 0, maxHistoryBytes: 12000 });
  h.history.splice(
    0,
    h.history.length,
    ...[...h.history].sort(newestFirst).slice(0, 80),
  );
  await h.open();
  const last = [...h.history].sort(newestFirst).at(-1);
  assert.exists(last);
  let event!: RelayEvent;
  for (let nonce = 0; !event || event.id <= last.id; nonce++)
    event = message(h.alice, "c", `isolated ${nonce}${"x".repeat(7000)}`, T0);
  h.live.receive([event], { channelId: "c", phase: "live" });
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.reads.at(-1)?.before_id).not.toBe(event.id);
  expect(h.window().hasMore).toBe(true);
});

it("bounds combined dense-second seek pages around the cached target", async () => {
  const h = setup({ count: 0 });
  for (let i = 0; i < 80; i++)
    h.history.push(
      message(h.alice, "c", `dense${i}`, T0, [
        ["metadata", "x".repeat(128 * 1024)],
      ]),
    );
  await h.open();
  for (let step = 0; step < 3; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const target = [...h.history].sort(newestFirst)[60];
  assert.exists(target);
  expect(h.window().rows.some((row) => row.id === target.id)).toBe(true);
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  await h.channels.seek?.("c", T0, new AbortController().signal, target.id);
  const ids = new Set(h.window().rows.map((row) => row.id));
  expect(ids.has(target.id)).toBe(true);
  expect(
    byteSize(h.history.filter((event) => ids.has(event.id))),
  ).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it("purges a cached channel when exact-target seek revalidation is denied", async () => {
  const h = setup({ count: 450, spacing: 0 });
  await h.open();
  const target = h.window().rows[10];
  assert.exists(target);
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  h.gate.denied = true;
  await expect(
    h.channels.seek?.("c", T0, new AbortController().signal, target.id),
  ).rejects.toThrow();
  expect(h.window().rows).toEqual([]);
  expect(h.window().status).toBe("error");
  expect(h.channels.list().channels.some((channel) => channel.id === "c")).toBe(
    false,
  );
});

it("restarts a pending forward seek from a ceiling retreated by live byte eviction", async () => {
  const h = setup({ count: 500, maxHistoryRows: 300 });
  await h.open();
  for (let step = 0; step < 15; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().hasNewer).toBe(true);
  const expected = h.window().rows.map((row) => row.id);
  const target = h.window().rows[0];
  assert.exists(target);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Set<string>();
  const before = h.reads.length;
  h.channels.loadNewer?.("c");
  try {
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
    const reaction = signed(h.alice, {
      kind: 7,
      created_at: T0 + 501 * HOUR,
      content: "+",
      tags: [
        ["h", "c"],
        ["e", target.id],
        ["metadata", "x".repeat(8 * 1024 * 1024 - 10000)],
      ],
    });
    h.live.receive([reaction]);
    for (const row of h.window().rows) seen.add(row.id);
    expect(
      expected.filter((id) => !h.window().rows.some((row) => row.id === id))
        .length,
    ).toBeGreaterThan(200);
  } finally {
    release();
    h.gate.hold = undefined;
  }
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  for (const row of h.window().rows) seen.add(row.id);
  for (let step = 0; h.window().hasNewer && step < 20; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(expected.filter((id) => !seen.has(id))).toEqual([]);
});

it.each(
  [40003, 5].flatMap((kind) =>
    [true, false].map((channelTag) => ({ kind, channelTag })),
  ),
)(
  "preserves incoming-page overlay %j when live eviction moves the older cursor",
  async ({ kind, channelTag }) => {
    const h = setup({ count: 100, maxHistoryRows: 40 });
    await h.open();
    const target = h.history[75];
    assert.exists(target);
    await h.owner.session.read([{ ids: [target.id], limit: 1 }]);
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    const before = h.reads.length;
    h.channels.loadOlder("c");
    try {
      await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
      h.live.receive([
        signed(h.alice, {
          kind,
          created_at: T0 + 101 * HOUR,
          tags: [...(channelTag ? [["h", "c"]] : []), ["e", target.id]],
          content: kind === 40003 ? "edited incoming page" : "",
        }),
      ]);
      h.live.receive(
        Array.from({ length: 21 }, (_, i) =>
          message(h.alice, "c", `new${i}`, T0 + 102 * HOUR + i),
        ),
      );
    } finally {
      release();
      h.gate.hold = undefined;
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    }
    const row = h.window().rows.find((row) => row.id === target.id);
    if (kind === 40003) expect(row?.content).toBe("edited incoming page");
    else expect(row?.content).not.toBe(target.content);
  },
);

it("includes retained live roots in cached seek row admission", async () => {
  const h = setup({ count: 161, spacing: 0, maxHistoryRows: 40 });
  const traffic = [...h.history].sort(newestFirst)[70];
  assert.exists(traffic);
  // Reserve an interior root before loading, rather than signing until a
  // random ID lands between two adjacent roots in a dense second.
  h.history.splice(h.history.indexOf(traffic), 1);
  await h.open();
  for (let step = 0; step < 3; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const ids = h
    .window()
    .rows.map((row) => row.id)
    .sort();
  const target = ids[0];
  assert.exists(target);
  h.history.push(traffic);
  h.live.receive([traffic], { channelId: "c", phase: "live" });
  expect(h.window().rows.some((row) => row.id === traffic.id)).toBe(true);
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  await h.channels.seek?.("c", T0, new AbortController().signal, target);
  expect(h.window().rows.some((row) => row.id === target)).toBe(true);
  expect(h.window().rows.length).toBeLessThanOrEqual(40);
});

it.each(["live", "replay"] as const)(
  "keeps accepted %s overlap roots when an older read restores its joining snapshot",
  async (phase) => {
    const h = setup({ count: 100, maxHistoryRows: 40 });
    await h.open();
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    const before = h.reads.length;
    h.channels.loadOlder("c");
    const root = message(h.alice, "c", "overlap root", T0 + 70 * HOUR + 1);
    try {
      await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
      h.history.push(root);
      h.live.receive([root], { channelId: "c", phase });
      expect(h.window().rows.some((row) => row.id === root.id)).toBe(true);
    } finally {
      release();
      h.gate.hold = undefined;
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    }
    expect(h.window().rows.some((row) => row.id === root.id)).toBe(true);
  },
);

it("admits the oldest replacement head row after a replayed deletion", async () => {
  const h = setup({ count: 21, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  const target = h.history.pop();
  assert.exists(target);
  const deletion = signed(h.alice, {
    kind: 5,
    created_at: T0 + 22 * HOUR,
    tags: [
      ["h", "c"],
      ["e", target.id],
    ],
    content: "",
  });
  h.live.receive([deletion], { channelId: "c", phase: "replay" });
  h.gate.aux = [deletion];
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  expect(h.window().rows.some((row) => row.id === h.history[0]?.id)).toBe(true);
  expect(h.window().hasMore).toBe(false);
});

it("revalidates a missing exact target within a retained boundary second", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  const pair = [
    message(h.alice, "c", "boundary one", T0 + 79 * HOUR),
    message(h.alice, "c", "boundary two", T0 + 79 * HOUR),
  ].sort(newestFirst);
  const target = pair[0],
    boundary = pair[1];
  assert.exists(target);
  assert.exists(boundary);
  h.history[79] = boundary;
  await h.open();
  for (let step = 0; step < 2; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  h.history.push(target);
  expect(h.window().hasNewer).toBe(true);
  expect(h.window().rows.some((row) => row.id === target.id)).toBe(false);
  await h.channels.seek?.(
    "c",
    target.created_at,
    new AbortController().signal,
    target.id,
  );
  expect(h.window().rows.some((row) => row.id === target.id)).toBe(true);
});

it("keeps a cursor-second live root through eviction during an older read", async () => {
  const h = setup({ count: 100, maxHistoryRows: 41 });
  const pair = [
    message(h.alice, "c", "boundary", T0 + 60 * HOUR),
    message(h.alice, "c", "boundary live", T0 + 60 * HOUR),
  ].sort(newestFirst);
  const boundary = pair[0],
    root = pair[1];
  assert.exists(boundary);
  assert.exists(root);
  h.history[60] = boundary;
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  const before = h.reads.length;
  h.channels.loadOlder("c");
  try {
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
    // This arrival is absent from the pending response's relay snapshot.
    h.live.receive([root], { channelId: "c", phase: "live" });
    expect(h.window().rows.some((row) => row.id === root.id)).toBe(true);
    const traffic = Array.from({ length: 41 }, (_, i) =>
      message(h.alice, "c", `new live ${i}`, T0 + (100 + i) * HOUR),
    );
    h.history.push(...traffic);
    h.live.receive(traffic, { channelId: "c", phase: "live" });
    expect(h.window().rows.some((row) => row.id === root.id)).toBe(false);
  } finally {
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    h.history.push(root);
  }
  expect(h.window().rows.some((row) => row.id === root.id)).toBe(true);
});

it("restores a suspended sliding public preview to the current head", async () => {
  const h = setup({
    count: 100,
    maxHistoryRows: 40,
    publicPreview: true,
    seed: 0,
  });
  await h.open();
  await h.seek(T0 + 40 * HOUR);
  expect(h.window().hasNewer).toBe(true);
  for (let i = 0; i < 3; i++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }

  h.live.state({
    status: "connected",
    routes: [
      {
        id: "preview",
        channelId: "c",
        status: "error",
        replay: "unknown",
        error: "restricted: channel access revoked",
      },
    ],
  });
  expect(h.window().rows).toHaveLength(0);
  await vi.waitFor(() => expect(h.channels.get?.("c")?.readOnly).toBe(true));
  h.live.established("c");
  await vi.waitFor(() =>
    expect(
      h.owner.session.live.snapshot().heads.find((job) => job.channelId === "c")
        ?.state,
    ).toBe("verified"),
  );
  await vi.waitFor(() => expect(h.window().status).toBe("ready"));

  expect(h.window().rows.length).toBeGreaterThan(0);
  expect(h.window().rows.at(-1)?.content).toBe("m99");
});

it("preserves unread same-second history across an anchored forward trim", async () => {
  const h = setup({ count: 160, spacing: 0, maxHistoryBytes: 12000, seed: 3 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const before = h.reads.at(-1);
  const ordered = [...h.history].sort(newestFirst);
  // The settled page covers 20 roots after the previous cursor.
  const pageStart = ordered.findIndex((e) => e.id === before?.before_id);
  const committed = h.window().historyLimited
    ? before?.before_id
    : ordered[pageStart + 20]?.id;
  assert.exists(committed);
  const candidates = Array.from({ length: 64 }, (_, i) =>
    message(h.alice, "c", `isolated ${i} ${"x".repeat(7000)}`, T0),
  );
  const root = candidates.find(
    (e) =>
      e.id > committed &&
      ordered.some((row) => row.id > committed && row.id < e.id),
  );
  assert.exists(root);
  h.live.receive([root], { channelId: "c", phase: "live" });
  expect(h.window().rows.some((r) => r.id === root.id)).toBe(true);

  if (!h.window().historyLimited) {
    h.gate.probeFailure = true;
    const count = h.reads.length;
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(count));
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));

    expect(h.reads.at(-1)?.before_id).toBe(committed);
    h.gate.probeFailure = false;
  }
  h.channels.loadNewer?.("c", root.id);
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));

  expect(h.reads.at(-1)?.before_id).toBe(committed);
});

it.each([40003, 5])(
  "preserves reference-only overlay %s after preview-tail eviction",
  async (kind) => {
    const h = setup({ count: 100, maxHistoryRows: 40 });
    await h.open();
    const target = h.history[75];
    assert.exists(target);
    await h.owner.session.read([{ ids: [target.id], limit: 1 }]);
    let release!: () => void;
    h.gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = h.reads.length;
    h.channels.loadOlder("c");
    try {
      await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
      h.live.receive(
        Array.from({ length: 256 }, (_, i) =>
          message(h.alice, "c", `tail eviction ${i}`, T0 + (102 + i) * HOUR),
        ),
      );
      h.live.receive([
        signed(h.alice, {
          kind,
          created_at: T0 + 400 * HOUR,
          tags: [["e", target.id]],
          content: kind === 40003 ? "edited past tail" : "",
        }),
      ]);
    } finally {
      h.gate.hold = undefined;
      release();
    }
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    const row = h.window().rows.find((row) => row.id === target.id);
    if (kind === 40003) expect(row?.content).toBe("edited past tail");
    else expect(row?.content).not.toBe(target.content);
  },
);

it("preserves the pending overlap interval after its boundary root is deleted", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const boundary = h.history[60];
  assert.exists(boundary);
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = h.reads.length;
  h.channels.loadOlder("c");
  const root = message(
    h.alice,
    "c",
    "delayed boundary root",
    T0 + 60 * HOUR + 1,
  );
  try {
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
    h.live.receive([
      signed(h.alice, {
        kind: 5,
        created_at: T0 + 101 * HOUR,
        tags: [
          ["h", "c"],
          ["e", boundary.id],
        ],
        content: "",
      }),
    ]);
    h.live.receive([root], { channelId: "c", phase: "live" });
    expect(h.window().rows.some((row) => row.id === root.id)).toBe(true);
    h.live.receive(
      Array.from({ length: 41 }, (_, i) =>
        message(h.alice, "c", `evict overlap ${i}`, T0 + (102 + i) * HOUR),
      ),
    );
  } finally {
    h.gate.hold = undefined;
    release();
  }
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.some((row) => row.id === root.id)).toBe(true);
});

it("keeps the pending composite boundary after newer live eviction", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40, seed: 1 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const boundary = h.history[60];
  assert.exists(boundary);
  const delayed = Array.from({ length: 64 }, (_, i) =>
    message(h.alice, "c", `late same second ${i}`, boundary.created_at),
  ).find((event) => event.id > boundary.id);
  assert.exists(delayed);
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = h.reads.length;
  h.channels.loadOlder("c");
  try {
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
    h.live.receive(
      Array.from({ length: 41 }, (_, i) =>
        message(h.alice, "c", `advance pending ${i}`, T0 + (102 + i) * HOUR),
      ),
      { channelId: "c", phase: "live" },
    );
    h.live.receive([delayed], { channelId: "c", phase: "live" });
  } finally {
    h.gate.hold = undefined;
    release();
  }
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.some((row) => row.id === delayed.id)).toBe(true);
});

it.each(["tail", "lookup", "evicted"])(
  "does not charge a foreign reference-only overlay from %s to pending history",
  async (source) => {
    const h = setup({ count: 100, maxHistoryBytes: 12000 });
    await h.open();
    const foreign = message(h.alice, "other", "other root", T0 + 100 * HOUR);
    h.live.receive([
      roster(h.relay, "other", [h.viewer.pubkey]),
      metadata(h.relay, "other", "Other"),
      ...(source !== "lookup" ? [foreign] : []),
    ]);
    if (source === "lookup") {
      h.history.push(foreign);
      await h.owner.session.read([{ ids: [foreign.id], limit: 1 }]);
      h.history.pop();
    }
    if (source === "evicted")
      h.live.receive(
        Array.from({ length: 256 }, (_, i) =>
          message(
            h.alice,
            "other",
            `evict foreign ${i}`,
            T0 + (102 + i) * HOUR,
          ),
        ),
      );
    let release!: () => void;
    h.gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.channels.loadOlder("c");
    try {
      h.live.receive([
        signed(h.alice, {
          kind: 40003,
          content: "x".repeat(12000),
          created_at: T0 + 101 * HOUR,
          tags: [["e", foreign.id]],
        }),
      ]);
      expect(h.window().error).toBeUndefined();
      expect(h.window().loadingOlder).toBe(true);
    } finally {
      h.gate.hold = undefined;
      release();
    }
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    expect(h.window().error).toBeUndefined();
  },
);

it.each(["composite", "timestamp"])(
  "revalidates a %s dense-second target through signed small pages",
  async (boundary) => {
    const h = setup({ count: 120, spacing: 0, seed: 120 });
    await h.open();
    while (h.window().hasMore) {
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false), {
        interval: 1,
      });
    }
    const target = [...h.history].sort(newestFirst)[
      boundary === "composite" ? 90 : 119
    ];
    assert.exists(target);
    expect(h.window().rows.some((row) => row.id === target.id)).toBe(true);
    h.live.state({ status: "connected", routes: [] });
    h.live.state({ status: "retrying", routes: [] });
    h.gate.pageSize = 2;
    const before = h.reads.length;
    await h.channels.seek?.(
      "c",
      T0,
      new AbortController().signal,
      boundary === "composite" ? target.id : "f".repeat(64),
    );
    expect(h.reads.length - before).toBeLessThanOrEqual(40);
    expect(h.window().freshness).toBe("verified");
    expect(h.window().rows.some((row) => row.id === target.id)).toBe(true);
  },
);

it("recovers byte-evicted neighbours around a late interior live root", async () => {
  const h = setup({
    count: 100,
    maxHistoryRows: 100,
    maxHistoryBytes: 8 * 1024 * 1024,
  });
  for (let i = 0; i < h.history.length; i++)
    h.history[i] = message(h.alice, "c", `m${i}`, T0 + i * HOUR, [
      ["metadata", "x".repeat(128 * 1024)],
    ]);
  await h.open();
  for (let page = 0; !h.window().hasNewer && page < 8; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false), {
      interval: 1,
    });
  }
  expect(h.window().hasNewer).toBe(true);
  const expected = h.window().rows.map((row) => row.id);
  const late = message(h.alice, "c", "late interior", T0 + 75 * HOUR + 1, [
    ["metadata", "x".repeat(768 * 1024)],
  ]);
  h.history.push(late);
  h.live.receive([late], { channelId: "c", phase: "live" });
  const seen = new Set(h.window().rows.map((row) => row.id));
  expect(expected.some((id) => !seen.has(id))).toBe(true);
  for (let page = 0; h.window().hasNewer && page < 30; page++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy(), {
      interval: 1,
    });
    expect(h.window().error).toBeUndefined();
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(expected.filter((id) => !seen.has(id))).toEqual([]);
  expect(seen.has(late.id)).toBe(true);
});

it("keeps the live head attached when new messages exceed the byte budget", async () => {
  const h = setup({
    count: 50,
    maxHistoryRows: 100,
    maxHistoryBytes: 8 * 1024 * 1024,
  });
  for (let i = 0; i < h.history.length; i++)
    h.history[i] = message(h.alice, "c", `m${i}`, T0 + i * HOUR, [
      ["metadata", "x".repeat(128 * 1024)],
    ]);
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows).toHaveLength(40);
  expect(h.window().hasNewer).toBeFalsy();
  const latest = message(h.alice, "c", "new live head", T0 + 50 * HOUR, [
    ["metadata", "x".repeat(4 * 1024 * 1024)],
  ]);
  h.history.push(latest);
  h.live.receive([latest], { channelId: "c", phase: "live" });
  expect(h.window().rows.some((row) => row.id === latest.id)).toBe(true);
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.window().hasMore).toBe(true);
  const ids = new Set(h.window().rows.map((row) => row.id));
  expect(
    byteSize(h.history.filter((event) => ids.has(event.id))),
  ).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it.each([false, true])(
  "does not let a held head-only catch-up replace a forward-attached cursor (failed=%s)",
  async (failed) => {
    const h = setup({ count: 300, maxHistoryRows: 40 });
    await h.open();
    h.live.state({ status: "connected", routes: [] });
    h.live.established("c");
    await vi.waitFor(() =>
      expect(h.owner.session.live?.snapshot().heads).toContainEqual({
        channelId: "c",
        state: "verified",
      }),
    );
    for (let page = 0; page < 10; page++) {
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    }
    let release!: () => void;
    h.gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = h.reads.length;
    h.live.state({ status: "retrying", routes: [] });
    h.live.state({ status: "connected", routes: [] });
    h.live.established("c");
    try {
      await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
      h.gate.hold = undefined;
      for (let page = 0; h.window().hasNewer && page < 30; page++) {
        h.channels.loadNewer?.("c");
        await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
      }
      expect(h.window().hasNewer).toBeFalsy();
      const oldest = Math.min(...h.times());
      h.gate.failHead = failed;
      release();
      await vi.waitFor(() =>
        expect(h.owner.session.live?.snapshot().heads).toContainEqual({
          channelId: "c",
          state: "verified",
        }),
      );
      expect(h.window().error).toBeUndefined();
      h.live.state({ status: "retrying", routes: [] });
      h.live.state({ status: "connected", routes: [] });
      h.gate.failHead = false;
      h.live.established("c");
      await vi.waitFor(() =>
        expect(h.owner.session.live?.snapshot().heads).toContainEqual({
          channelId: "c",
          state: "verified",
        }),
      );
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
      expect(h.times()).toContain(oldest - HOUR);
    } finally {
      h.gate.hold = undefined;
      release();
    }
  },
);

it("preserves the committed older cursor through a head-only catch-up at the byte cap", async () => {
  const h = setup({ count: 450, spacing: 0, maxHistoryBytes: 12000, seed: 30 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.owner.session.live?.snapshot().heads).toContainEqual({
      channelId: "c",
      state: "verified",
    }),
  );
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const boundary = h
    .window()
    .rows.map((row) => row.id)
    .sort()
    .at(-1);
  assert.exists(boundary);
  const threshold = [...h.history].sort(newestFirst)[350];
  assert.exists(threshold);
  const payload = "x".repeat(
    12000 - byteSize([message(h.alice, "c", "", T0)]) - 100,
  );
  let isolated!: RelayEvent;
  for (
    let nonce = 0;
    !isolated || isolated.id <= threshold.id || isolated.id <= boundary;
    nonce++
  ) {
    assert(nonce < 100, "bounded signed fixture search");
    isolated = message(h.alice, "c", `isolated${nonce}${payload}`, T0);
  }
  h.history.push(isolated);
  expect(byteSize([isolated])).toBeLessThan(12000);
  h.live.receive([isolated], { channelId: "c", phase: "live" });
  expect(h.window().rows.some((row) => row.id === isolated.id)).toBe(true);

  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const before = h.reads.at(-1)?.before_id;
  const head = [...h.history].sort(newestFirst)[0];
  assert.exists(head);
  h.gate.aux = [
    signed(h.alice, {
      kind: 7,
      content: "+",
      created_at: T0 + HOUR,
      tags: [
        ["h", "c"],
        ["e", head.id],
        ["metadata", "x".repeat(1000)],
      ],
    }),
  ];
  h.live.state({ status: "retrying", routes: [] });
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.owner.session.live?.snapshot().heads).toContainEqual({
      channelId: "c",
      state: "verified",
    }),
  );
  h.gate.aux = [];
  const reads = h.reads.length;
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.reads.length).toBeGreaterThan(reads);
  expect(h.reads.at(-1)?.before_id).toBe(before);
});

it("admits a missed interior root from a forward response without importing older context", async () => {
  const h = setup({ count: 100, maxHistoryRows: 60 });
  await h.open();
  for (let i = 0; !h.window().hasNewer && i < 8; i++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().hasNewer).toBe(true);
  const rows = h.window().rows;
  const middle = rows[Math.floor(rows.length / 2)];
  assert.exists(middle);
  const first = rows[0];
  assert.exists(first);
  const missed = message(h.alice, "c", "missed interior", middle.createdAt + 1);
  const outside = message(
    h.alice,
    "c",
    "outside older cursor",
    first.createdAt - 1,
  );
  h.history.push(missed, outside);
  expect(h.window().rows.some((row) => row.id === missed.id)).toBe(false);
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.some((row) => row.id === missed.id)).toBe(true);
  expect(h.window().rows.some((row) => row.id === outside.id)).toBe(false);
});

it("R20 forward seek admits a newly returned interior root", async () => {
  const h = setup({ count: 600, maxHistoryRows: 2400 });
  await h.open();
  await h.seek(T0 + 350 * HOUR);
  expect(h.window().hasNewer).toBe(true);
  const rows = h.window().rows;
  const middle = rows[Math.floor(rows.length / 2)];
  assert.exists(middle);
  const missed = message(h.alice, "c", "missed interior", middle.createdAt + 1);
  h.history.push(missed);
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.some((row) => row.id === missed.id)).toBe(true);
});

it.each([10, 30])(
  "keeps a backdated live root in its read-owned page (offset=%s)",
  async (offset) => {
    const h = setup({ count: 100, maxHistoryRows: 2400 });
    await h.open();
    const oldest = h.window().rows[0];
    assert.exists(oldest);
    const root = message(
      h.alice,
      "c",
      "backdated during older read",
      oldest.createdAt - offset * HOUR + 1,
    );
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    const before = h.reads.length;
    h.channels.loadOlder("c");
    try {
      await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(before));
      h.live.receive([root], { channelId: "c", phase: "live" });
    } finally {
      release();
      h.gate.hold = undefined;
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    }
    expect(h.window().rows.some((row) => row.id === root.id)).toBe(
      offset === 10,
    );
    if (offset === 30) {
      const boundary = h.window().rows[0];
      assert.exists(boundary);
      h.history.push(root);
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
      expect(h.reads.at(-1)).toMatchObject({
        until: boundary.createdAt,
        before_id: boundary.id,
      });
      expect(h.window().rows.some((row) => row.id === root.id)).toBe(true);
    }
  },
);
