// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type {
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
} from "../relay/contracts";
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

it("waits for a head refresh before reading older pages for the message", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  let clock = 1_000_000;
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  /** The next channel read; profile reads get nothing. */
  const read = () => {
    for (;;) {
      const entry = scripted.next();
      if (entry.filters[0]?.["#h"]) return entry;
      entry.respond([]);
    }
  };
  const store = createRelaySession(scripted.transport, {
    prepared: true,
    now: () => clock,
  });
  try {
    const channels = store.session.channels;
    channels.ensureList();
    scripted
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "a"),
      ]);
    await flush();
    const target = message(alice, "a", "target", 10);
    const newer = message(alice, "a", "newer", 20);
    const head = [
      newer,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ];
    channels.ensure("a");
    read().respond(head);
    await flush();
    expect(channels.window("a")).toMatchObject({
      status: "ready",
      freshness: "verified",
    });
    // Past the head's freshness lease, opening the channel refreshes its head.
    clock += 61_000;
    const view = renderHook(() => useMessageOpening(channels, "a", target.id));
    const refresh = read();
    expect(scripted.pending).toHaveLength(0);
    // A busy head is not missing history: no decision yet.
    expect(view.result.current).toBeUndefined();
    await act(async () => {
      refresh.respond(head);
      await flush();
    });
    expect(view.result.current).toBeUndefined();
    const older = read();
    expect(older.filters[0]?.until).toBe(20);
    await act(async () => {
      older.respond([
        target,
        bounds(relay, "a", `20:${newer.id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]);
      await flush();
    });
    expect(view.result.current).toBe(true);
  } finally {
    store.dispose();
  }
});
