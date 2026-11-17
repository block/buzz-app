import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { CHANNEL_ACTIVITY_KINDS, createChannelHeads } from "./channel-heads";
import type { RelayEvent } from "./events";
import { createRecovery } from "./recovery";
import { keypair, message, signed } from "./testing";

const peer = keypair();
const rootId = "f".repeat(64);
const reply = (channelId: string, created_at: number) =>
  message(peer, channelId, "reply", created_at, [
    ["e", rootId, "", "root"],
    ["e", rootId, "", "reply"],
  ]);
const forum = (channelId: string, kind: 45001 | 45003, created_at: number) =>
  signed(peer, {
    kind,
    created_at,
    content: "forum",
    tags: [["h", channelId]],
  });

type Read = {
  ids: readonly string[];
  topLevel: boolean;
  signal: AbortSignal;
  resolve(events: readonly RelayEvent[]): void;
  reject(error: unknown): void;
};

/** A head store whose reads wait until the test settles them. */
function harness({
  readable = () => true,
  reads = true,
}: {
  readable?: (id: string) => boolean;
  reads?: boolean;
} = {}) {
  const pending: Read[] = [];
  const read = vi.fn(
    (ids: readonly string[], topLevel: boolean, signal: AbortSignal) =>
      new Promise<readonly RelayEvent[]>((resolve, reject) =>
        pending.push({ ids: [...ids], topLevel, signal, resolve, reject }),
      ),
  );
  const heads = createChannelHeads({
    read: reads ? read : undefined,
    readable,
  });
  const heard: (readonly string[] | undefined)[] = [];
  heads.subscribe((ids) => heard.push(ids));
  return { heads, read, pending, heard };
}

function take(pending: Read[]): Read {
  const next = pending.shift();
  assert.exists(next, "Expected a pending read");
  return next;
}
/** Past the longest start jitter (500 ms of the first recovery delay). */
const start = () => vi.advanceTimersByTimeAsync(500);
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("spreads the first read across 250-500 ms before reading", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const h = harness();
  expect(h.heads.status()).toBe("idle");
  h.heads.cover(["alpha"]);
  // Scheduled is already loading: lists must not answer "empty" yet.
  expect(h.heads.status()).toBe("loading");
  expect(h.heard).toEqual([[]]);
  await vi.advanceTimersByTimeAsync(249);
  expect(h.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.read).toHaveBeenCalledOnce();

  const late = harness();
  vi.mocked(Math.random).mockReturnValue(0.98);
  late.heads.cover(["alpha"]);
  await vi.advanceTimersByTimeAsync(494);
  expect(late.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(6);
  expect(late.read).toHaveBeenCalledOnce();
  h.heads.dispose();
  late.heads.dispose();
});

it("reads the roster in serial batches of 128 across every activity kind", async () => {
  const h = harness();
  const ids = Array.from({ length: 257 }, (_, index) => `room-${index}`);
  h.heads.cover(ids);
  await start();
  expect(CHANNEL_ACTIVITY_KINDS).toEqual([9, 40002, 40008, 45001, 45003]);
  for (const [index, size] of [128, 128, 1].entries()) {
    // One request at a time: the next waits for this one.
    expect(h.pending).toHaveLength(1);
    const request = take(h.pending);
    expect(request.topLevel).toBe(false);
    expect(request.ids).toEqual(ids.slice(index * 128, index * 128 + size));
    const first = ids[index * 128];
    assert.exists(first);
    request.resolve([message(peer, first, "head", 100 + index)]);
    await settle();
    // Each batch lands as it arrives, announcing its own channels.
    expect(h.heads.last(first)).toBe(100 + index);
    expect(h.heads.settled(first)).toBe(true);
    expect(h.heard.at(index === 2 ? -2 : -1)).toEqual(request.ids);
    expect(h.heads.status()).toBe(index < 2 ? "loading" : "ready");
  }
  expect(h.read).toHaveBeenCalledTimes(3);
  // Channels without activity are known to have none.
  expect(h.heads.known("room-1")).toBe(true);
  expect(h.heads.last("room-1")).toBeUndefined();
  expect(h.heard.at(-1)).toEqual([]);
  h.heads.dispose();
});

it("reads top-level heads again only for channels whose newest event is not a top-level message", async () => {
  const h = harness();
  h.heads.cover(["top", "threaded", "forum", "posted", "diff", "empty"]);
  await start();
  const first = take(h.pending);
  first.resolve([
    message(peer, "top", "newest", 50),
    message(peer, "top", "older", 40),
    reply("threaded", 60),
    forum("forum", 45001, 70),
    forum("posted", 45003, 75),
    signed(peer, {
      kind: 40008,
      created_at: 80,
      content: "diff --git a/f b/f",
      tags: [["h", "diff"]],
    }),
  ]);
  await settle();
  // Recency comes from the first read, whatever kind it found.
  expect(h.heads.last("top")).toBe(50);
  expect(h.heads.last("threaded")).toBe(60);
  expect(h.heads.last("forum")).toBe(70);
  expect(h.heads.last("diff")).toBe(80);
  expect(h.heads.known("empty")).toBe(true);
  expect(h.heads.last("empty")).toBeUndefined();
  expect(h.heard.at(-1)).toEqual(["top", "diff", "empty"]);
  for (const id of ["top", "diff", "empty"])
    expect(h.heads.settled(id)).toBe(true);
  for (const id of ["threaded", "forum", "posted"])
    expect(h.heads.settled(id)).toBe(false);
  expect(h.heads.status()).toBe("loading");

  const second = take(h.pending);
  expect(second.topLevel).toBe(true);
  expect(second.ids).toEqual(["threaded", "forum", "posted"]);
  second.resolve([message(peer, "threaded", "top-level", 30)]);
  await settle();
  expect(h.heard.slice(-2)).toEqual([["threaded", "forum", "posted"], []]);
  for (const id of ["threaded", "forum", "posted"])
    expect(h.heads.settled(id)).toBe(true);
  // The top-level pass answers the preview, not when the channel was active.
  expect(h.heads.last("threaded")).toBe(60);
  expect(h.heads.status()).toBe("ready");
  expect(h.pending).toHaveLength(0);
  expect(h.read).toHaveBeenCalledTimes(2);
  h.heads.dispose();
});

it("ignores unsupported kinds, ambiguous scopes and channels outside the batch", async () => {
  const h = harness();
  h.heads.cover(["alpha"]);
  await start();
  const ambiguous = signed(peer, {
    kind: 9,
    created_at: 100,
    content: "ambiguous",
    tags: [
      ["h", "alpha"],
      ["h", "beta"],
    ],
  });
  const reaction = signed(peer, {
    kind: 7,
    created_at: 200,
    content: "+",
    tags: [["h", "alpha"]],
  });
  take(h.pending).resolve([
    message(peer, "alpha", "visible", 40),
    ambiguous,
    reaction,
    message(peer, "beta", "unrequested", 300),
  ]);
  await settle();
  expect(h.heads.last("alpha")).toBe(40);
  expect(h.heads.settled("alpha")).toBe(true);
  expect(h.heads.known("beta")).toBe(false);
  h.heads.accept([ambiguous, reaction]);
  expect(h.heads.last("alpha")).toBe(40);
  h.heads.dispose();
});

it("never moves live activity back with an older or empty read result", async () => {
  const h = harness();
  h.heads.cover(["alpha", "quiet"]);
  await start();
  const held = take(h.pending);
  h.heads.accept([message(peer, "alpha", "live", 90)]);
  h.heads.accept([message(peer, "quiet", "live", 95)]);
  expect(h.heard.slice(-2)).toEqual([["alpha"], ["quiet"]]);
  held.resolve([message(peer, "alpha", "stale read", 60)]);
  await settle();
  expect(h.heads.last("alpha")).toBe(90);
  expect(h.heads.last("quiet")).toBe(95);
  expect(h.heads.settled("alpha")).toBe(true);

  // Live activity only advances, and an unchanged one announces nothing.
  const heard = h.heard.length;
  h.heads.accept([message(peer, "alpha", "older", 70)]);
  expect(h.heads.last("alpha")).toBe(90);
  expect(h.heard).toHaveLength(heard);
  h.heads.accept([
    signed(peer, {
      kind: 40008,
      created_at: 120,
      content: "diff",
      tags: [["h", "alpha"]],
    }),
  ]);
  expect(h.heads.last("alpha")).toBe(120);
  expect(h.heard.at(-1)).toEqual(["alpha"]);
  h.heads.dispose();
});

it("reads only new channels when the roster grows and forgets removed ones", async () => {
  const h = harness();
  h.heads.cover(["alpha", "beta"]);
  await start();
  take(h.pending).resolve([
    message(peer, "alpha", "a", 50),
    message(peer, "beta", "b", 60),
  ]);
  await settle();
  expect(h.heads.status()).toBe("ready");

  // The same roster, reordered or repeated, reads nothing.
  h.heads.cover(["beta", "alpha", "alpha"]);
  await start();
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.heads.status()).toBe("ready");

  h.heads.cover(["alpha", "beta", "gamma"]);
  await start();
  const grown = take(h.pending);
  expect(grown.ids).toEqual(["gamma"]);
  grown.resolve([]);
  await settle();
  expect(h.heads.settled("gamma")).toBe(true);

  const heard = h.heard.length;
  h.heads.cover(["alpha", "gamma"]);
  expect(h.heard.slice(heard)).toEqual([[]]);
  expect(h.heads.known("beta")).toBe(false);
  expect(h.heads.settled("beta")).toBe(false);
  expect(h.heads.last("alpha")).toBe(50);
  await start();
  expect(h.read).toHaveBeenCalledTimes(2);

  // A channel that comes back is read again.
  h.heads.cover(["alpha", "beta", "gamma"]);
  await start();
  expect(take(h.pending).ids).toEqual(["beta"]);
  h.heads.dispose();
});

it("does not keep a channel the roster dropped while its read was in flight", async () => {
  const h = harness();
  h.heads.cover(["alpha", "beta"]);
  await start();
  const held = take(h.pending);
  h.heads.cover(["alpha"]);
  held.resolve([
    message(peer, "alpha", "a", 50),
    message(peer, "beta", "gone", 60),
  ]);
  await settle();
  expect(h.heads.last("alpha")).toBe(50);
  expect(h.heads.known("beta")).toBe(false);
  expect(h.heads.settled("beta")).toBe(false);
  h.heads.dispose();
});

it("skips channels it cannot read", async () => {
  const h = harness({ readable: (id) => id !== "secret" });
  h.heads.cover(["alpha", "secret"]);
  await start();
  const request = take(h.pending);
  expect(request.ids).toEqual(["alpha"]);
  request.resolve([]);
  await settle();
  expect(h.heads.status()).toBe("ready");
  expect(h.read).toHaveBeenCalledOnce();
  h.heads.dispose();
});

it("a failed batch keeps what landed, reports failure, and a retry reads only what is unsettled", async () => {
  const h = harness();
  const ids = Array.from({ length: 129 }, (_, index) => `room-${index}`);
  h.heads.cover(ids);
  await start();
  take(h.pending).resolve([message(peer, "room-0", "landed", 90)]);
  await settle();
  h.heads.accept([message(peer, "room-128", "live", 70)]);
  take(h.pending).reject(new Error("offline"));
  await settle();
  expect(h.heads.status()).toBe("error");
  expect(h.heads.recovery.status()).toBe("failed");
  expect(h.heard.at(-1)).toEqual([]);
  expect(h.heads.last("room-0")).toBe(90);
  expect(h.heads.settled("room-127")).toBe(true);
  expect(h.heads.settled("room-128")).toBe(false);
  expect(h.heads.last("room-128")).toBe(70);
  // Failure does not loop on its own.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.read).toHaveBeenCalledTimes(2);

  h.heads.recovery.retry();
  expect(h.heads.recovery.status()).toBe("busy");
  await start();
  const retried = take(h.pending);
  expect(retried.ids).toEqual(["room-128"]);
  expect(retried.topLevel).toBe(false);
  retried.resolve([]);
  await settle();
  expect(h.heads.recovery.status()).toBe("settled");
  expect(h.heads.status()).toBe("ready");
  // Live activity outlived the empty retry.
  expect(h.heads.last("room-128")).toBe(70);
  h.heads.dispose();
});

it("session recovery retries a failed head read through its recovery source", async () => {
  const h = harness();
  h.heads.cover(["busy"]);
  await start();
  take(h.pending).reject(new TypeError("offline"));
  await settle();
  const recovery = createRecovery([h.heads.recovery]);
  try {
    expect(recovery.snapshot().recovering).toBe(true);
    recovery.retryNow();
    await start();
    take(h.pending).resolve([]);
    await settle();
    expect(h.heads.settled("busy")).toBe(true);
    expect(recovery.snapshot().recovering).toBe(false);
  } finally {
    recovery.dispose();
    h.heads.dispose();
  }
});

it("retain drops only channels no longer kept and rereads the unsettled rest", async () => {
  const readable = new Set(["alpha", "beta"]);
  const h = harness({ readable: (id) => readable.has(id) });
  h.heads.cover(["alpha", "beta"]);
  await start();
  take(h.pending).resolve([
    message(peer, "alpha", "a", 50),
    message(peer, "beta", "b", 60),
  ]);
  await settle();
  readable.delete("alpha");
  h.heads.retain((id) => readable.has(id));
  expect(h.heard.at(-1)).toBeUndefined();
  expect(h.heads.known("alpha")).toBe(false);
  expect(h.heads.settled("alpha")).toBe(false);
  expect(h.heads.last("beta")).toBe(60);
  await start();
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.heads.status()).toBe("ready");

  // Access returning reads that channel alone.
  readable.add("alpha");
  h.heads.retain((id) => readable.has(id));
  await start();
  expect(take(h.pending).ids).toEqual(["alpha"]);
  h.heads.dispose();
});

it("retain aborts an in-flight read so its late answer cannot land", async () => {
  const h = harness();
  h.heads.cover(["alpha", "beta"]);
  await start();
  const held = take(h.pending);
  const heard = h.heard.length;
  h.heads.retain(() => true);
  expect(held.signal.aborted).toBe(true);
  // Nothing was dropped: only the restarted read's status is announced.
  expect(h.heard.slice(heard)).toEqual([[]]);
  held.resolve([message(peer, "alpha", "late", 90)]);
  await settle();
  expect(h.heads.known("alpha")).toBe(false);
  await start();
  const again = take(h.pending);
  expect(again.ids).toEqual(["alpha", "beta"]);
  again.resolve([message(peer, "alpha", "fresh", 100)]);
  await settle();
  expect(h.heads.last("alpha")).toBe(100);
  h.heads.dispose();
});

it("clear fences an in-flight read, forgets every head, and reads the roster again", async () => {
  const h = harness();
  h.heads.cover(["alpha", "beta"]);
  await start();
  take(h.pending).resolve([message(peer, "alpha", "a", 50)]);
  await settle();
  h.heads.cover(["alpha", "beta", "gamma"]);
  await start();
  const held = take(h.pending);
  h.heads.clear();
  expect(held.signal.aborted).toBe(true);
  expect(h.heard.at(-2)).toBeUndefined();
  expect(h.heads.known("alpha")).toBe(false);
  expect(h.heads.settled("alpha")).toBe(false);
  expect(h.heads.status()).toBe("loading");
  held.resolve([message(peer, "gamma", "late", 90)]);
  await settle();
  expect(h.heads.known("gamma")).toBe(false);
  await start();
  const again = take(h.pending);
  expect(again.ids).toEqual(["alpha", "beta", "gamma"]);
  again.resolve([]);
  await settle();
  expect(h.heads.status()).toBe("ready");
  expect(h.heads.last("alpha")).toBeUndefined();
  h.heads.dispose();
});

it("dispose aborts reads and ignores everything after it", async () => {
  const h = harness();
  h.heads.cover(["alpha"]);
  await start();
  const held = take(h.pending);
  const heard = h.heard.length;
  h.heads.dispose();
  expect(held.signal.aborted).toBe(true);
  held.resolve([message(peer, "alpha", "late", 90)]);
  await settle();
  h.heads.accept([message(peer, "alpha", "retired", 100)]);
  h.heads.observed([message(peer, "alpha", "retired", 100)]);
  h.heads.cover(["alpha", "beta"]);
  h.heads.retain(() => false);
  h.heads.clear();
  await start();
  expect(h.heads.known("alpha")).toBe(false);
  expect(h.heard).toHaveLength(heard);
  expect(h.read).toHaveBeenCalledOnce();
  const late = vi.fn();
  h.heads.subscribe(late)();
  expect(late).not.toHaveBeenCalled();
});

it("tells subscribers which channels admitted events touched", () => {
  const h = harness();
  h.heads.observed([
    message(peer, "alpha", "a", 1),
    message(peer, "beta", "b", 2),
    message(peer, "alpha", "again", 3),
  ]);
  expect(h.heard).toEqual([["alpha", "beta"]]);
  h.heads.observed([signed(peer, { kind: 0, content: "{}", tags: [] })]);
  expect(h.heard).toHaveLength(1);
  // Observation is not activity: it changes no head.
  expect(h.heads.known("alpha")).toBe(false);
  h.heads.dispose();
});

it("reads nothing without a reader but still follows live activity", async () => {
  const h = harness({ reads: false });
  expect(h.heads.status()).toBe("unavailable");
  h.heads.cover(["alpha"]);
  await start();
  expect(h.read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.heads.status()).toBe("unavailable");
  expect(h.heads.recovery.status()).toBe("settled");
  expect(h.heads.settled("alpha")).toBe(false);
  h.heads.accept([message(peer, "alpha", "live", 90)]);
  expect(h.heads.last("alpha")).toBe(90);
  h.heads.dispose();
});
