// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { assert, expect, it, vi } from "vitest";
import type {
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
} from "../relay/contracts";
import { ReadError } from "../relay/errors";
import type { RelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import { createRelaySession } from "../relay/session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "../relay/testing";
import { SEEK_PAGES, useMessageOpening } from "./use-message-opening";

/** A channel whose history is `pages` pages of top-level rows, oldest first;
 * the head is the last page. Older pages arrive when `deliver` is called. */
function channel(pages: string[][], replies: Record<string, string> = {}) {
  const row = (id: string) =>
    ({ id, threadRootId: replies[id] }) as unknown as ChannelMessage;
  let loaded = 1;
  let window: ChannelWindow = {
    channelId: "c",
    status: "loading",
    rows: [],
    hasMore: true,
    loadingOlder: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const set = (next: Partial<ChannelWindow>) => {
    window = { ...window, ...next };
    for (const listener of listeners) listener();
  };
  const rows = () => pages.slice(-loaded).flat().map(row);
  const loadOlder = vi.fn(() => {
    if (window.loadingOlder) return;
    set({ loadingOlder: true });
  });
  const queries = {
    window: () => window,
    subscribeWindow: (_: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: vi.fn(),
    loadOlder,
  } as unknown as ChannelQueries;
  return {
    queries,
    set: (patch: Partial<ChannelWindow>) => act(() => set(patch)),
    loadOlder,
    /** A cached window: readable rows, not yet verified against the relay. */
    cached(ids: string[], error?: string) {
      act(() =>
        set({
          status: "ready",
          freshness: "cached",
          rows: ids.map(row),
          hasMore: true,
          error,
        }),
      );
    },
    head() {
      act(() =>
        set({
          status: "ready",
          freshness: "verified",
          rows: rows(),
          hasMore: pages.length > 1,
        }),
      );
    },
    deliver() {
      act(() => {
        loaded += 1;
        set({
          loadingOlder: false,
          rows: rows(),
          hasMore: loaded < pages.length,
        });
      });
    },
  };
}

it("opens a top-level message in the head without reading older pages", () => {
  const c = channel([["old"], ["new", "target"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  expect(view.result.current).toBeUndefined();
  c.head();
  expect(view.result.current).toBe(true);
  expect(c.loadOlder).not.toHaveBeenCalled();
});

it("reads older pages until the message loads, then opens it in the timeline", () => {
  const c = channel([["target"], ["b"], ["c"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  c.head();
  expect(view.result.current).toBeUndefined();
  c.deliver();
  expect(view.result.current).toBeUndefined();
  c.deliver();
  expect(view.result.current).toBe(true);
  expect(c.loadOlder).toHaveBeenCalledTimes(2);
});

it("opens a reply, or a message not in the history, as its thread", () => {
  const reply = channel([["root", "reply"]], { reply: "root" });
  const replyView = renderHook(() =>
    useMessageOpening(reply.queries, "c", "reply"),
  );
  reply.head();
  expect(replyView.result.current).toBe(false);
  const missing = channel([["a"], ["b"]]);
  const missingView = renderHook(() =>
    useMessageOpening(missing.queries, "c", "gone"),
  );
  missing.head();
  missing.deliver();
  expect(missingView.result.current).toBe(false);
  expect(missing.loadOlder).toHaveBeenCalledOnce();
});

it(`stops after ${SEEK_PAGES} older pages and opens the thread`, () => {
  const c = channel([
    ["target"],
    // One page beyond the last one it reads.
    ...Array.from({ length: SEEK_PAGES + 1 }, (_, i) => [`m${i}`]),
  ]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  c.head();
  for (let page = 0; page < SEEK_PAGES; page += 1) c.deliver();
  expect(view.result.current).toBe(false);
  expect(c.loadOlder).toHaveBeenCalledTimes(SEEK_PAGES);
});

it("waits through a cached window and opens what verified history shows", () => {
  const c = channel([["old"], ["new", "target"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  // The cached head predates the target: not yet evidence that it is missing.
  c.cached(["old"]);
  expect(view.result.current).toBeUndefined();
  expect(c.loadOlder).not.toHaveBeenCalled();
  c.head();
  expect(view.result.current).toBe(true);
  expect(c.loadOlder).not.toHaveBeenCalled();
});

it("a failed revalidation of a cached window opens the thread", () => {
  const c = channel([["new", "target"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", "target"));
  c.cached(["new"], "offline");
  expect(view.result.current).toBe(false);
});

it("reads no window without a message", () => {
  const c = channel([["a"]]);
  const view = renderHook(() => useMessageOpening(c.queries, "c", undefined));
  expect(view.result.current).toBeUndefined();
  expect(c.queries.ensure).not.toHaveBeenCalled();
});

/** A real relay session with one channel, "a", whose head the test scripts.
 * `head(...)` is a first page whose oldest row has more history before it. */
async function relayChannel(withLive = false) {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const time = { now: 1_000_000 };
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const store = createRelaySession(
    withLive
      ? {
          ...scripted.transport,
          subscribe(callbacks) {
            live = callbacks;
            return { update() {}, retry() {}, dispose() {} };
          },
        }
      : scripted.transport,
    {
      prepared: true,
      now: () => time.now,
    },
  );
  store.session.channels.ensureList();
  scripted
    .next()
    .respond([roster(relay, "a", [viewer.pubkey]), metadata(relay, "a", "a")]);
  await flush();
  return {
    store,
    channels: store.session.channels,
    live,
    pending: scripted.pending,
    time,
    post: (content: string, at: number) => message(alice, "a", content, at),
    head: (...rows: ReturnType<typeof message>[]) => {
      const last = rows[rows.length - 1];
      return [
        ...rows,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: last
            ? { created_at: last.created_at, id: last.id }
            : null,
        }),
      ];
    },
    older: (
      before: ReturnType<typeof message>,
      row: ReturnType<typeof message>,
    ) => [
      row,
      bounds(relay, "a", `${before.created_at}:${before.id}`, {
        has_more: true,
        next_cursor: { created_at: row.created_at, id: row.id },
      }),
    ],
    end: (
      before: ReturnType<typeof message>,
      ...rows: ReturnType<typeof message>[]
    ) => [
      ...rows,
      bounds(relay, "a", `${before.created_at}:${before.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ],
    /** The next channel read; profile reads get nothing. */
    read() {
      for (;;) {
        const entry = scripted.next();
        if (entry.filters[0]?.["#h"]) return entry;
        entry.respond([]);
      }
    },
  };
}

it("waits for a head refresh before reading older pages for the message", async () => {
  const c = await relayChannel();
  try {
    const target = c.post("target", 10);
    const newer = c.post("newer", 20);
    c.channels.ensure("a");
    c.read().respond(c.head(newer));
    await flush();
    expect(c.channels.window("a")).toMatchObject({
      status: "ready",
      freshness: "verified",
    });
    // Past the head's freshness lease, opening the channel refreshes its head.
    c.time.now += 61_000;
    const view = renderHook(() =>
      useMessageOpening(c.channels, "a", target.id),
    );
    const refresh = c.read();
    expect(c.pending).toHaveLength(0);
    // A busy head is not missing history: no decision yet.
    expect(view.result.current).toBeUndefined();
    await act(async () => {
      refresh.respond(c.head(newer));
      await flush();
    });
    expect(view.result.current).toBeUndefined();
    const older = c.read();
    expect(older.filters[0]?.until).toBe(20);
    await act(async () => {
      older.respond(c.end(newer, target));
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    c.store.dispose();
  }
});

it("decides on the refreshed head, not the expired one that held the message", async () => {
  const c = await relayChannel();
  try {
    const target = c.post("target", 10);
    const newer = c.post("newer", 20);
    c.channels.ensure("a");
    c.read().respond(c.head(target));
    await flush();
    expect(c.channels.window("a").rows.map((row) => row.id)).toEqual([
      target.id,
    ]);
    c.time.now += 61_000;
    const view = renderHook(() =>
      useMessageOpening(c.channels, "a", target.id),
    );
    // The expired head still shows the message, but it may be stale.
    expect(view.result.current).toBeUndefined();
    const refresh = c.read();
    // A newer post pushed the message out of the head.
    await act(async () => {
      refresh.respond(c.head(newer));
      await flush();
    });
    expect(c.channels.window("a").rows.map((row) => row.id)).toEqual([
      newer.id,
    ]);
    expect(view.result.current).toBeUndefined();
    const older = c.read();
    await act(async () => {
      older.respond(c.end(newer, target));
      await flush();
    });
    expect(view.result.current).toBe(true);
    expect(c.channels.window("a").rows.map((row) => row.id)).toContain(
      target.id,
    );
  } finally {
    c.store.dispose();
  }
});

it("waits for a queued catch-up retry instead of deciding on its earlier failure", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  /** The next channel head read; profile reads get nothing. */
  const read = () => {
    for (;;) {
      const entry = wire.next();
      if (entry.filters[0]?.["#h"]) return entry;
      entry.respond([]);
    }
  };
  try {
    const channels = owner.session.channels;
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    const older = message(alice, "a", "older", 10);
    const page = (...rows: ReturnType<typeof message>[]) => [
      ...rows,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: { created_at: 10, id: older.id },
      }),
    ];
    channels.ensure("a");
    read().respond(page(older));
    await flush();
    // The stream reconnects and its catch-up read fails.
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    read().fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    expect(channels.window("a")).toMatchObject({
      status: "ready",
      freshness: "cached",
      error: expect.any(String),
    });
    // The target arrived while the stream was down.
    const target = message(alice, "a", "target", 20);
    const view = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    // Opening demands the channel, which queues a retry: not yet a failure.
    expect(view.result.current).toBeUndefined();
    const retry = read();
    await act(async () => {
      retry.respond(page(target, older));
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    owner.dispose();
  }
});

it("waits for a queued retry of an empty failed channel while catch-up slots are busy", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  /** The pending head read for one channel; profile reads get nothing. */
  const take = (id: string) => {
    for (const entry of [...wire.pending])
      if (!entry.filters[0]?.["#h"]) {
        wire.pending.splice(wire.pending.indexOf(entry), 1);
        entry.respond([]);
      }
    const index = wire.pending.findIndex((entry) =>
      entry.filters[0]?.["#h"]?.includes(id),
    );
    const [entry] = index < 0 ? [] : wire.pending.splice(index, 1);
    assert(entry, `no pending read for ${id}`);
    return entry;
  };
  const empty = (id: string) => [
    bounds(relay, id, "head", { has_more: false, next_cursor: null }),
  ];
  try {
    const channels = owner.session.channels;
    live.receive(
      ["a", "b", "c"].map((id) => roster(relay, id, [viewer.pubkey])),
    );
    for (const id of ["b", "c"]) {
      channels.ensure(id);
      take(id).respond(empty(id));
      await flush();
    }
    // "a" never loaded: its first read failed, and so did its catch-up.
    channels.ensure("a");
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    expect(channels.window("a")).toMatchObject({ status: "error", rows: [] });
    // Hold both catch-up slots with other channels' reads.
    live.established("c");
    live.established("b");
    await flush();
    const first = take("c");
    channels.ensure("b");
    await flush();
    const second = take("b");
    const target = message(alice, "a", "target", 20);
    const view = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    // The retry is queued behind the busy slots: not yet a failure.
    expect(wire.pending.filter((entry) => entry.filters[0]?.["#h"])).toEqual(
      [],
    );
    expect(view.result.current).toBeUndefined();
    await act(async () => {
      first.respond(empty("c"));
      second.respond(empty("b"));
      await flush();
    });
    expect(view.result.current).toBeUndefined();
    const retry = take("a");
    await act(async () => {
      retry.respond([target, ...empty("a")]);
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    owner.dispose();
  }
});

it("reads an empty channel again when the stream drops before its queued retry runs", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const heads = () => wire.pending.filter((entry) => entry.filters[0]?.["#h"]);
  /** The pending head read for one channel; profile reads get nothing. */
  const take = (id: string) => {
    for (const entry of [...wire.pending])
      if (!entry.filters[0]?.["#h"]) {
        wire.pending.splice(wire.pending.indexOf(entry), 1);
        entry.respond([]);
      }
    const index = wire.pending.findIndex((entry) =>
      entry.filters[0]?.["#h"]?.includes(id),
    );
    const [entry] = index < 0 ? [] : wire.pending.splice(index, 1);
    assert(entry, `no pending read for ${id}`);
    return entry;
  };
  const empty = (id: string) => [
    bounds(relay, id, "head", { has_more: false, next_cursor: null }),
  ];
  try {
    const channels = owner.session.channels;
    live.receive(
      ["a", "b", "c"].map((id) => roster(relay, id, [viewer.pubkey])),
    );
    for (const id of ["b", "c"]) {
      channels.ensure(id);
      take(id).respond(empty(id));
      await flush();
    }
    // "a" never loaded: its first read failed, and so did its catch-up.
    channels.ensure("a");
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    take("a").fail(new ReadError("unavailable", "Relay unavailable", 503));
    await flush();
    // Hold both catch-up slots, so the retry for "a" stays queued.
    live.established("c");
    live.established("b");
    await flush();
    take("c");
    channels.ensure("b");
    await flush();
    take("b");
    const target = message(alice, "a", "target", 20);
    const first = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    expect(heads()).toEqual([]);
    expect(channels.window("a").status).toBe("loading");
    // The stream drops before the queued retry is dispatched.
    await act(async () => {
      live.state({ status: "connecting", routes: [] });
      await flush();
    });
    expect(channels.window("a").status).not.toBe("loading");
    first.unmount();
    // Reopening reads the channel over HTTP instead of waiting for the stream.
    const view = renderHook(() => useMessageOpening(channels, "a", target.id));
    await act(flush);
    expect(view.result.current).toBeUndefined();
    const read = take("a");
    await act(async () => {
      read.respond([target, ...empty("a")]);
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    owner.dispose();
  }
});

it.each(["cached", "verified"] as const)(
  "reattaches %s sliding history before deciding an evicted newer message is a thread",
  (freshness) => {
    const c = channel([["target"]]);
    const attach = vi.fn(() => c.set({ refreshing: true }));
    const queries = { ...c.queries, attach };
    const view = renderHook(() => useMessageOpening(queries, "c", "target"));
    c.set({
      status: "ready",
      rows: [],
      freshness,
      hasMore: false,
      hasNewer: true,
    });
    expect(attach).toHaveBeenCalledWith("c");
    expect(c.loadOlder).not.toHaveBeenCalled();
    expect(view.result.current).toBeUndefined();
    c.set({
      refreshing: false,
      hasNewer: false,
      freshness: "verified",
      rows: [{ id: "target" } as ChannelMessage],
    });
    expect(view.result.current).toBe(true);
    expect(attach).toHaveBeenCalledTimes(1);
  },
);

it("does not reattach an already decided request when its row is later evicted", () => {
  const c = channel([["target"]]);
  const attach = vi.fn();
  const view = renderHook(() =>
    useMessageOpening({ ...c.queries, attach }, "c", "target"),
  );
  c.head();
  expect(view.result.current).toBe(true);
  c.set({ rows: [], hasNewer: true });
  expect(view.result.current).toBe(true);
  expect(attach).not.toHaveBeenCalled();
});

it.each([true, false])(
  "revalidates a retained cached target with hasNewer=%s",
  async (hasNewer) => {
    const c = channel([["target"]]);
    const attach = vi.fn();
    const target = { id: "target", createdAt: 123 } as ChannelMessage;
    const seek = vi.fn(async () => {
      c.set({ freshness: "verified", rows: [target] });
      return target.id;
    });
    const queries = { ...c.queries, attach, seek };
    const view = renderHook(() => useMessageOpening(queries, "c", "target"));
    c.set({
      status: "ready",
      rows: [target],
      freshness: "cached",
      hasMore: true,
      hasNewer,
    });
    expect(seek).toHaveBeenCalledWith(
      "c",
      123,
      expect.any(AbortSignal),
      "target",
    );
    expect(attach).not.toHaveBeenCalled();
    await act(flush);
    expect(view.result.current).toBe(true);
  },
);

it.each(["unmount", "target"])(
  "cancels cached-target revalidation on %s retirement",
  async (retirement) => {
    const c = channel([["target"]]);
    let signal!: AbortSignal;
    const seek = vi.fn(
      (_channel: string, _from: number, current: AbortSignal) => {
        signal = current;
        return new Promise<string | undefined>(() => {});
      },
    );
    const queries = { ...c.queries, attach: vi.fn(), seek };
    const view = renderHook(
      ({ target }) => useMessageOpening(queries, "c", target),
      {
        initialProps: { target: "target" },
      },
    );
    c.set({
      status: "ready",
      freshness: "cached",
      hasNewer: true,
      rows: [{ id: "target", createdAt: 123 } as ChannelMessage],
    });
    expect(seek).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    if (retirement === "unmount") view.unmount();
    else view.rerender({ target: "another" });
    expect(signal.aborted).toBe(true);
  },
);

it("opens a missing older target without discarding its retained search edge", async () => {
  const target = message(keypair(), "c", "target", 10);
  const c = channel([[target.id], ["retained"]]);
  const attach = vi.fn(() =>
    c.set({ rows: [], hasMore: false, hasNewer: false }),
  );
  const read = vi.fn(async () => [target]);
  const seek = vi.fn(async () => {
    c.set({ rows: [{ id: target.id } as ChannelMessage], hasNewer: true });
    return target.id;
  });
  c.head();
  c.set({ hasNewer: true });
  const queries = { ...c.queries, attach, seek };
  const view = renderHook(() =>
    useMessageOpening(queries, "c", target.id, undefined, read),
  );
  await act(flush);
  if (c.loadOlder.mock.calls.length) c.deliver();
  expect(view.result.current).toBe(true);
  expect(attach).not.toHaveBeenCalled();
});

it.each(["unmount", "target"])(
  "cancels a missing target read on %s retirement",
  async (retirement) => {
    const target = message(keypair(), "c", "target", 10);
    const c = channel([[target.id], ["retained"]]);
    c.head();
    c.set({ hasNewer: true });
    let signal!: AbortSignal;
    let release!: (events: readonly (typeof target)[]) => void;
    const read = vi.fn<RelaySession["read"]>((_filters, options) => {
      assert.exists(options?.signal);
      signal = options.signal;
      return new Promise<readonly (typeof target)[]>((resolve) => {
        release = resolve;
      });
    });
    const seek = vi.fn();
    const queries = { ...c.queries, attach: vi.fn(), seek };
    const view = renderHook(
      ({ id }) => useMessageOpening(queries, "c", id, undefined, read),
      { initialProps: { id: target.id } },
    );
    expect(read).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    const pending = { signal, release };
    if (retirement === "unmount") view.unmount();
    else view.rerender({ id: "another" });
    // Keep the old operation's resolver even if the replacement starts a read.
    expect(pending.signal.aborted).toBe(true);
    await act(async () => {
      pending.release([target]);
      await flush();
    });
    expect(seek).not.toHaveBeenCalled();
  },
);

it.each(["missing", "failed"])(
  "settles a %s signed target read without replacing retained history",
  async (outcome) => {
    const c = channel([["old"], ["retained"]]);
    c.head();
    c.set({ hasNewer: true });
    const read = vi.fn(async () => {
      if (outcome === "failed") throw new Error("offline");
      return [];
    });
    const queries = { ...c.queries, attach: vi.fn(), seek: vi.fn() };
    const view = renderHook(() =>
      useMessageOpening(queries, "c", "target", undefined, read),
    );
    await act(flush);
    expect(view.result.current).toBe(false);
    expect(queries.attach).not.toHaveBeenCalled();
    expect(queries.seek).not.toHaveBeenCalled();
    expect(queries.window("c").rows.map((row) => row.id)).toEqual(["retained"]);
  },
);

it.each([true, false])(
  "settles a retained target after an attached older-page retry (present=%s)",
  async (present) => {
    const c = await relayChannel();
    try {
      const newest = c.post("newest", 30);
      const target = c.post("target", 20);
      const oldest = c.post("oldest", 10);
      c.channels.ensure("a");
      c.read().respond(c.head(newest));
      await flush();
      c.channels.loadOlder("a");
      c.read().respond(c.older(newest, target));
      await flush();
      c.channels.loadOlder("a");
      c.read().fail(new Error("older page failed"));
      await flush();
      expect(c.channels.window("a").freshness).toBe("cached");
      c.channels.loadOlder("a");
      c.read().respond(c.end(target, oldest));
      await flush();
      expect(c.channels.window("a")).toMatchObject({
        freshness: "cached",
        error: undefined,
      });
      expect(c.channels.window("a").hasNewer).toBeFalsy();
      const view = renderHook(() =>
        useMessageOpening(c.channels, "a", target.id),
      );
      expect(view.result.current).toBeUndefined();
      for (let page = 0; page < (present ? 2 : 1); page++) {
        const read = c.read();
        await act(async () => {
          read.respond(
            c.head(...(present ? [newest, target, oldest] : [oldest])),
          );
          await flush();
        });
      }
      expect(view.result.current).toBe(present);
      view.unmount();
    } finally {
      c.store.dispose();
    }
  },
);

it("settles retained cached revalidation when seeking installs no segment", async () => {
  const c = channel([["target"]]);
  const target = { id: "target", createdAt: 123 } as ChannelMessage;
  const seek = vi.fn(async () => "target");
  const queries = { ...c.queries, attach: vi.fn(), seek };
  const view = renderHook(() => useMessageOpening(queries, "c", "target"));
  c.set({
    status: "ready",
    rows: [target],
    freshness: "cached",
    hasMore: true,
  });
  await act(async () => {
    await flush();
  });
  expect(seek).toHaveBeenCalledTimes(1);
  expect(view.result.current).toBe(false);
});

it.each([true, false])(
  "keeps a retained-target seek pending through concurrent verification (present=%s)",
  async (present) => {
    const c = channel([["target"]]);
    const target = { id: "target", createdAt: 123 } as ChannelMessage;
    let release!: (id: string | undefined) => void;
    const seek = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          release = resolve;
        }),
    );
    c.set({ status: "ready", freshness: "cached", rows: [target] });
    const queries = { ...c.queries, attach: vi.fn(), seek };
    const view = renderHook(() => useMessageOpening(queries, "c", "target"));
    try {
      expect(seek).toHaveBeenCalledOnce();
      c.set({ freshness: "verified" });
      expect(view.result.current).toBeUndefined();
      await act(async () => {
        c.set({ freshness: "verified", rows: present ? [target] : [] });
        release(present ? target.id : undefined);
        await flush();
      });
      expect(view.result.current).toBe(present);
    } finally {
      release(undefined);
      view.unmount();
    }
  },
);

it("settles a lookup-admitted target when seeking leaves attached history cached", async () => {
  const c = await relayChannel();
  try {
    const newest = c.post("newest", 20);
    const oldest = c.post("oldest", 10);
    const target = c.post("deleted before seek", 30);
    c.channels.ensure("a");
    c.read().respond(c.head(newest));
    await flush();
    c.channels.loadOlder("a");
    c.read().fail(new Error("older page failed"));
    await flush();
    c.channels.loadOlder("a");
    c.read().respond(c.end(newest, oldest));
    await flush();
    expect(c.channels.window("a")).toMatchObject({
      freshness: "cached",
      error: undefined,
    });
    expect(c.channels.window("a").hasNewer).toBeFalsy();
    const view = renderHook(() =>
      useMessageOpening(
        c.channels,
        "a",
        target.id,
        undefined,
        c.store.session.read,
      ),
    );
    try {
      const lookup = c.read();
      expect(lookup.filters[0]?.ids).toEqual([target.id]);
      await act(async () => {
        lookup.respond([target]);
        await flush();
      });
      expect(c.channels.window("a").rows.map((row) => row.id)).toContain(
        target.id,
      );
      expect(view.result.current).toBeUndefined();
      await act(async () => {
        c.read().respond(c.head(newest, oldest));
        await flush();
      });
      expect(c.channels.window("a").freshness).toBe("cached");
      expect(c.channels.window("a").rows.map((row) => row.id)).toContain(
        target.id,
      );
      expect(view.result.current).toBe(false);
    } finally {
      view.unmount();
    }
  } finally {
    c.store.dispose();
  }
});

it("rejects a lookup target when unrelated reconnect verification precedes a no-install seek", async () => {
  const c = await relayChannel(true);
  try {
    const newest = c.post("newest", 20),
      oldest = c.post("oldest", 10),
      target = c.post("gone before seek", 30);
    c.channels.ensure("a");
    c.read().respond(c.head(newest));
    await flush();
    c.channels.loadOlder("a");
    c.read().fail(new Error("older page failed"));
    await flush();
    c.channels.loadOlder("a");
    c.read().respond(c.end(newest, oldest));
    await flush();
    c.live.state({ status: "connected", routes: [] });
    c.live.established("a");
    await flush();
    const reconnectRead = c.read();
    const view = renderHook(() =>
      useMessageOpening(
        c.channels,
        "a",
        target.id,
        undefined,
        c.store.session.read,
      ),
    );
    try {
      await act(async () => {
        c.read().respond([target]);
        await flush();
      });
      const seekRead = c.read();
      expect(c.channels.window("a").rows.map((row) => row.id)).toContain(
        target.id,
      );
      await act(async () => {
        reconnectRead.respond(c.head(newest, oldest));
        await flush();
      });
      expect(c.channels.window("a").freshness).toBe("verified");
      expect(view.result.current).toBeUndefined();
      await act(async () => {
        seekRead.respond(c.head(newest, oldest));
        await flush();
      });
      expect(view.result.current).toBe(false);
    } finally {
      view.unmount();
    }
  } finally {
    c.store.dispose();
  }
});

it.each([true, false])(
  "validates a lookup target against the installed seek response (present=%s)",
  async (present) => {
    const c = await relayChannel();
    try {
      const newest = c.post("newest", 40);
      const oldest = c.post("oldest", 10);
      const target = c.post("deleted before seek", 30);
      c.channels.ensure("a");
      c.read().respond(c.head(newest));
      await flush();
      c.channels.loadOlder("a");
      c.read().fail(new Error("older page failed"));
      await flush();
      c.channels.loadOlder("a");
      c.read().respond(c.end(newest, oldest));
      await flush();
      expect(c.channels.window("a")).toMatchObject({
        freshness: "cached",
        error: undefined,
      });
      expect(c.channels.window("a").hasNewer).toBeFalsy();
      const view = renderHook(() =>
        useMessageOpening(
          c.channels,
          "a",
          target.id,
          undefined,
          c.store.session.read,
        ),
      );
      try {
        const lookup = c.read();
        expect(lookup.filters[0]?.ids).toEqual([target.id]);
        await act(async () => {
          lookup.respond([target]);
          await flush();
        });
        expect(c.channels.window("a").rows.map((row) => row.id)).toContain(
          target.id,
        );
        expect(view.result.current).toBeUndefined();
        await act(async () => {
          c.read().respond(c.head(newest, oldest));
          await flush();
          c.read().respond(
            c.head(newest, ...(present ? [target] : []), oldest),
          );
          await flush();
        });
        expect(c.channels.window("a").freshness).toBe("verified");
        expect(c.channels.window("a").rows.map((row) => row.id)).toContain(
          target.id,
        );
        expect(view.result.current).toBe(present);
      } finally {
        view.unmount();
      }
    } finally {
      c.store.dispose();
    }
  },
);

it.each([true, false])(
  "validates delayed lookup after reconnect wins (present=%s)",
  async (present) => {
    const c = await relayChannel(true);
    try {
      const newest = c.post("newest", 20),
        oldest = c.post("oldest", 10),
        target = c.post("gone before seek", 30);
      c.channels.ensure("a");
      c.read().respond(c.head(newest));
      await flush();
      c.channels.loadOlder("a");
      c.read().fail(new Error("older page failed"));
      await flush();
      c.channels.loadOlder("a");
      c.read().respond(c.end(newest, oldest));
      await flush();
      c.live.state({ status: "connected", routes: [] });
      c.live.established("a");
      await flush();
      const reconnectRead = c.read();
      const view = renderHook(() =>
        useMessageOpening(
          c.channels,
          "a",
          target.id,
          undefined,
          c.store.session.read,
        ),
      );
      try {
        const lookup = c.read();
        await act(async () => {
          reconnectRead.respond(c.head(newest, oldest));
          await flush();
        });
        expect(c.channels.window("a").freshness).toBe("verified");
        expect(view.result.current).toBeUndefined();
        await act(async () => {
          lookup.respond([target]);
          await flush();
        });
        expect(view.result.current).toBeUndefined();
        await act(async () => {
          c.read().respond(
            c.head(...(present ? [target] : []), newest, oldest),
          );
          await flush();
          if (present) {
            c.read().respond(c.head(target, newest, oldest));
            await flush();
          }
        });
        expect(view.result.current).toBe(present);
      } finally {
        view.unmount();
      }
    } finally {
      c.store.dispose();
    }
  },
);
