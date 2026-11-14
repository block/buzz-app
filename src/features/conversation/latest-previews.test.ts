import { createRecovery } from "../relay/recovery";
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import {
  createChannelPreviews,
  loadedPreview,
} from "../relay/channel-previews";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import type { RelayReader } from "../relay/reader";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { useLatestMessages } from "./latest-previews";

const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});
function fixture(read: RelayReader["read"], ids = ["busy", "empty"]) {
  const viewer = keypair(),
    relay = keypair();
  let emit = (_events: readonly import("../relay/events").RelayEvent[]) => {};
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query: async (filters, signal) => [
      ...(await read(filters, signal ? { signal } : {})),
    ],
    media: () => undefined,
    subscribe(callbacks) {
      emit = callbacks.receive;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  stops.push(owner.dispose);
  emit(
    ids.flatMap((id) => [
      roster(relay, id, [viewer.pubkey], 1),
      metadata(relay, id, id, 1),
    ]),
  );
  return owner.session;
}
const previewFilter = (filters: Parameters<RelayReader["read"]>[0]) =>
  filters.every((filter) => filter.top_level && filter.limit === 1);

test("visible demand asks for bounded top-level previews through canonical session admission", async () => {
  const author = keypair();
  const read = vi.fn<RelayReader["read"]>(async (filters) =>
    previewFilter(filters) ? [message(author, "busy", "current", 100)] : [],
  );
  const session = fixture(read);
  const { result } = renderHook(() =>
    useLatestMessages(session, ["busy", "empty"]),
  );
  await waitFor(() =>
    expect(result.current.get("busy")?.content).toBe("current"),
  );
  expect(result.current.get("empty")).toBeNull();
  expect(
    session.unread.snapshot({ kind: "channel", channelId: "busy" })
      .latestTopLevel?.content,
  ).toBe("current");
  expect(
    read.mock.calls.filter(([filters]) => previewFilter(filters)),
  ).toHaveLength(1);
  expect(
    read.mock.calls.find(([filters]) => previewFilter(filters))?.[0],
  ).toEqual([
    {
      kinds: [40002, 40008, 9],
      "#h": ["busy"],
      limit: 1,
      top_level: true,
      include_aux: true,
    },
    {
      kinds: [40002, 40008, 9],
      "#h": ["empty"],
      limit: 1,
      top_level: true,
      include_aux: true,
    },
  ]);
});

test("more visible channels than one relay batch all finish without repeated reads", async () => {
  const ids = Array.from({ length: 11 }, (_, i) => `room-${i}`);
  const read = vi.fn<RelayReader["read"]>(async () => []);
  const session = fixture(read, ids);
  const { result, rerender } = renderHook(
    ({ wanted }) => useLatestMessages(session, wanted),
    { initialProps: { wanted: ids } },
  );
  await waitFor(() =>
    expect(ids.every((id) => result.current.has(id))).toBe(true),
  );
  const batches = read.mock.calls
    .filter(([filters]) => previewFilter(filters))
    .map(([filters]) => filters);
  expect(batches.map((filters) => filters.length)).toEqual([4, 4, 3]);
  expect(
    batches
      .flatMap((filters) => filters.flatMap((filter) => filter["#h"]))
      .sort(),
  ).toEqual([...ids].sort());
  rerender({ wanted: [...ids].reverse() });
  await act(async () => {});
  expect(
    read.mock.calls.filter(([filters]) => previewFilter(filters)),
  ).toHaveLength(3);
});

test("shared demand survives one list closing and aborts when its last consumer leaves", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (events: []) => void;
  const read = vi.fn<RelayReader["read"]>((filters, options) => {
    if (!previewFilter(filters)) return Promise.resolve([]);
    signal = options?.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const session = fixture(read);
  const first = renderHook(() => useLatestMessages(session, ["busy"]));
  const second = renderHook(() => useLatestMessages(session, ["busy"]));
  try {
    await waitFor(() => expect(signal).toBeDefined());
    first.unmount();
    await act(async () => {});
    expect(signal?.aborted).toBe(false);
    second.unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    await act(async () => finish([]));
  }
  const again = renderHook(() => useLatestMessages(session, ["busy"]));
  try {
    await waitFor(() =>
      expect(
        read.mock.calls.filter(([filters]) => previewFilter(filters)),
      ).toHaveLength(2),
    );
    expect(again.result.current.has("busy")).toBe(false);
  } finally {
    await act(async () => finish([]));
  }
});

test("joining an in-flight preview shares its result without repeating the read", async () => {
  const author = keypair();
  let finish:
    | ((events: Awaited<ReturnType<RelayReader["read"]>>) => void)
    | undefined;
  const read = vi.fn<RelayReader["read"]>((filters) => {
    if (!previewFilter(filters)) return Promise.resolve([]);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const session = fixture(read);
  const first = renderHook(() => useLatestMessages(session, ["busy"]));
  await waitFor(() => expect(finish).toBeDefined());
  const second = renderHook(() => useLatestMessages(session, ["busy"]));
  try {
    await act(async () =>
      finish?.([message(author, "busy", "Shared post", 100)]),
    );
    await waitFor(() =>
      expect(first.result.current.get("busy")?.content).toBe("Shared post"),
    );
    expect(second.result.current.get("busy")?.content).toBe("Shared post");
    expect(
      read.mock.calls.filter(([filters]) => previewFilter(filters)),
    ).toHaveLength(1);
  } finally {
    await act(async () => finish?.([]));
  }
});

test.each([
  { freshness: "verified" as const, hasNewer: false, reads: 0 },
  { freshness: "cached" as const, hasNewer: false, reads: 1 },
  { freshness: "verified" as const, hasNewer: true, reads: 1 },
])(
  "reuses only a complete verified head ($freshness, detached=$hasNewer)",
  async ({ freshness, hasNewer, reads }) => {
    const base = createRelaySession(null);
    stops.push(base.dispose);
    const row: ChannelMessage = {
      id: "head",
      channelId: "loaded",
      authorId: "alice",
      content: "current",
      createdAt: 100,
      mentions: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      participants: [],
    };
    const window: ChannelWindow = {
      ...base.session.channels.window("loaded"),
      status: "ready",
      freshness,
      hasNewer,
      rows: [row],
    };
    const read = vi.fn<RelayReader["read"]>(async () => []);
    const previews = createChannelPreviews({
      read,
      loaded: () => loadedPreview(window),
      latest: () => loadedPreview(window),
      readable: () => true,
      notify: (listener) => listener(),
    });
    stops.push(previews.dispose);
    const session = { ...base.session, channelPreviews: previews.capability };
    const { result } = renderHook(() => useLatestMessages(session, ["loaded"]));
    await act(async () => {});
    if (reads) await waitFor(() => expect(read).toHaveBeenCalledOnce());
    else expect(result.current.get("loaded")?.content).toBe("current");
    expect(read).toHaveBeenCalledTimes(reads);
  },
);

test.each([40002, 40008])(
  "previews retain canonical agent content (kind %s)",
  async (kind) => {
    const author = keypair();
    const event = signed(author, {
      kind,
      tags: [["h", "busy"]],
      content:
        kind === 40002
          ? JSON.stringify({ content: "Agent update" })
          : "Agent update",
      created_at: 100,
    });
    const read = vi.fn<RelayReader["read"]>(async (filters) =>
      previewFilter(filters) &&
      filters.some((filter) => filter.kinds?.includes(kind))
        ? [event]
        : [],
    );
    const session = fixture(read);
    const { result } = renderHook(() => useLatestMessages(session, ["busy"]));
    await waitFor(() =>
      expect(result.current.get("busy")).toMatchObject({
        id: event.id,
        content: "Agent update",
      }),
    );
  },
);

test("initial preview demand is spread before the first finite read", async () => {
  vi.useFakeTimers();
  const read = vi.fn<RelayReader["read"]>(async () => []);
  const previews = createChannelPreviews({
    read,
    latest: () => undefined,
    loaded: () => undefined,
    readable: () => true,
    notify: (listener) => listener(),
  });
  stops.push(previews.dispose);
  previews.capability.retain(["busy"]);
  await vi.advanceTimersByTimeAsync(249);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(251);
  expect(previews.capability.snapshot().get("busy")).toBeNull();
  expect(read).toHaveBeenCalledOnce();
});

test("session recovery retries failed preview demand without remounting its consumer", async () => {
  vi.useFakeTimers();
  const read = vi.fn<RelayReader["read"]>(async () => {
    throw new TypeError("offline");
  });
  const previews = createChannelPreviews({
    read,
    latest: () => undefined,
    loaded: () => undefined,
    readable: () => true,
    notify: (listener) => listener(),
  });
  stops.push(previews.dispose);
  previews.capability.retain(["busy"]);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(read).toHaveBeenCalledTimes(4);
  expect(previews.recovery.status()).toBe("failed");
  const recovery = createRecovery([previews.recovery]);
  stops.push(recovery.dispose);
  read.mockResolvedValue([]);
  recovery.retryNow();
  await vi.advanceTimersByTimeAsync(500);
  expect(previews.capability.snapshot().get("busy")).toBeNull();
  expect(recovery.snapshot().recovering).toBe(false);
});
