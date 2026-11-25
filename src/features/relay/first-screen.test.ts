import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createFirstScreens,
  NAMES_DEADLINE_MS,
  newMessagesLine,
  SPECULATIVE_RUNS,
  type FirstScreen,
  type FirstScreenSource,
  type RowAttention,
} from "./first-screen";
import type { ChannelMessage } from "./contracts";
import { ALLOW_LATE_NAMES } from "./late-names";

type Head = { channelId: string };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<FirstScreenSource<Head>> = {}) {
  const heads = new Map<string, ReturnType<typeof deferred<Head>>>();
  const names = deferred();
  const signals = new Map<string, AbortSignal>();
  const gathered: FirstScreen<Head>[] = [];
  const source: FirstScreenSource<Head> = {
    held: () => undefined,
    read(channelId, signal) {
      signals.set(channelId, signal);
      const head = deferred<Head>();
      heads.set(channelId, head);
      return {
        head: head.promise,
        names: () => names.promise,
      };
    },
    generation: () => "0",
    gathered: (screen) => gathered.push(screen),
    ...overrides,
  };
  return {
    screens: createFirstScreens(source),
    heads,
    names,
    signals,
    gathered,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("a screen the store holds is complete at once and reads nothing", () => {
  const read = vi.fn();
  const h = harness({
    held: (channelId) => ({ channelId }),
    read,
  });
  expect(h.screens.start("alpha")).toEqual({
    channelId: "alpha",
    head: { channelId: "alpha" },
    named: true,
  });
  expect(read).not.toHaveBeenCalled();
});

// Strict names: a screen waits for the names it shows, up to a deadline.
test.skipIf(ALLOW_LATE_NAMES)(
  "an open joins the run a hover started, and gets one screen once its names land",
  async () => {
    const h = harness();
    expect(h.screens.start("alpha", true)).toBeUndefined();
    expect(h.screens.start("alpha")).toBeUndefined();
    expect(h.heads.size).toBe(1);
    h.heads.get("alpha")?.resolve({ channelId: "alpha" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gathered).toEqual([]);
    h.names.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gathered).toEqual([
      {
        channelId: "alpha",
        head: { channelId: "alpha" },
        named: true,
      },
    ]);
  },
);

test.skipIf(ALLOW_LATE_NAMES)(
  "names past their deadline do not hold the screen",
  async () => {
    const h = harness();
    h.screens.start("alpha");
    h.heads.get("alpha")?.resolve({ channelId: "alpha" });
    await vi.advanceTimersByTimeAsync(NAMES_DEADLINE_MS - 1);
    expect(h.gathered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.gathered).toEqual([expect.objectContaining({ named: false })]);
  },
);

// Late names (a temporary exception, see late-names.ts): a screen paints when
// its head lands, with the names already held.
test.runIf(ALLOW_LATE_NAMES)(
  "an open joins the run a hover started, and paints with its head while names are still being read",
  async () => {
    const h = harness();
    expect(h.screens.start("alpha", true)).toBeUndefined();
    expect(h.screens.start("alpha")).toBeUndefined();
    expect(h.heads.size).toBe(1);
    h.heads.get("alpha")?.resolve({ channelId: "alpha" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gathered).toEqual([
      {
        channelId: "alpha",
        head: { channelId: "alpha" },
        named: false,
      },
    ]);
  },
);

test.runIf(ALLOW_LATE_NAMES)(
  "names the directory already holds count as named",
  async () => {
    const h = harness();
    h.names.resolve();
    h.screens.start("alpha");
    h.heads.get("alpha")?.resolve({ channelId: "alpha" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gathered).toEqual([expect.objectContaining({ named: true })]);
  },
);

test("hovers past the cap cancel the oldest, never an open", () => {
  const h = harness();
  h.screens.start("open");
  for (let i = 0; i <= SPECULATIVE_RUNS; i++)
    h.screens.start(`hover-${i}`, true);
  expect(h.signals.get("open")?.aborted).toBe(false);
  expect(h.signals.get("hover-0")?.aborted).toBe(true);
  for (let i = 1; i <= SPECULATIVE_RUNS; i++)
    expect(h.signals.get(`hover-${i}`)?.aborted).toBe(false);
});

test("the line goes above the first unread row after a read one, or none", () => {
  const rows = ["read", "own", "unread", "later"].map(
    (id) =>
      ({ id, authorId: id === "own" ? "viewer" : "author" }) as ChannelMessage,
  );
  const states: Record<string, RowAttention> = {
    read: {
      status: "ineligible",
      unread: false,
      forced: false,
      prefixRead: true,
    },
    unread: { status: "ineligible", unread: true, forced: false },
    later: { status: "ineligible", unread: true, forced: false },
  };
  const line = (
    complete: boolean,
    override: Record<string, RowAttention> = {},
  ) =>
    newMessagesLine(
      rows,
      "viewer",
      complete,
      (id) =>
        override[id] ??
        states[id] ?? { status: "ineligible", unread: false, forced: false },
    );
  expect(line(false)).toBe("unread");
  // Without a read row above it, only a channel's whole history places it.
  const unreadFirst = {
    read: { status: "ineligible", unread: true, forced: false },
  } as const;
  expect(line(false, unreadFirst)).toBeUndefined();
  expect(line(true, unreadFirst)).toBe("read");
  // Read state not held for a row never waits: no line.
  expect(
    line(false, {
      unread: { status: "unknown", unread: false, forced: false },
    }),
  ).toBeUndefined();
  // Nor does a row whose read state is still resolving, such as a reply
  // that may count as thread attention instead.
  expect(
    line(false, {
      unread: {
        status: "eligible",
        pending: true,
        unread: true,
        forced: false,
      },
    }),
  ).toBeUndefined();
});
