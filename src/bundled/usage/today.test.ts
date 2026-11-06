import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  SessionUsage,
} from "../../features/agents/service";
import { dayStart } from "./stats";
import {
  FRESH_MS,
  latestSession,
  SETTLE_MS,
  TURN_GAP_MS,
  todayStore,
} from "./today";

const agent = (name: string, place = "here"): Agent =>
  ({
    key: name.padEnd(64, "0"),
    pubkey: name.padEnd(64, "0"),
    name,
    type: "buzz.claude-code/claude",
    owner: "f".repeat(64),
    relay: "wss://relay.example.com",
    place,
    config: {},
  }) as unknown as Agent;
/** A session with one request the harness priced itself: its cost needs no
 * price data. */
const session = (id: string, at: number, usd: number): SessionUsage => ({
  id,
  revision: `${id}:${usd}`,
  gaps: [],
  channelId: "chan",
  startedAt: at,
  lastAt: at,
  observations: [
    {
      at,
      model: "claude-opus-5-5",
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: { usd, source: "test" },
    },
  ],
});
/** The session as a harness records one Buzz did not start. */
const unplaced = ({ channelId: _, ...rest }: SessionUsage): SessionUsage =>
  rest;
function host(list: Agent[], usage: RegisteredAgentType["usage"]) {
  const snapshot = {
    status: "ready",
    agents: list,
    running: list,
  } as unknown as AgentsSnapshot;
  const types = [
    { key: "buzz.claude-code/claude", title: "Claude", usage },
  ] as unknown as RegisteredAgentType[];
  return {
    snapshot: () => snapshot,
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
}

const noon = new Date(2026, 10, 6, 12).getTime();

it("adds up today's spend on this computer from local midnight", async () => {
  const sinces: number[] = [];
  const store = todayStore(
    host([agent("Pixel"), agent("Remote", "hosted")], async (_, options) => {
      sinces.push(options.since);
      return [
        session("today", noon - 60_000, 1.25),
        session("yesterday", dayStart(noon) - 60_000, 9),
      ];
    }),
    () => noon,
  );
  await store.refresh();
  // The hosted agent runs elsewhere, so only Pixel is read.
  expect(sinces).toEqual([dayStart(noon)]);
  const today = store.get();
  expect(today?.agents).toBe(1);
  expect(today?.result.cost).toEqual({ value: 1.25, partial: false });
  expect(today?.result.agents.map((entry) => entry.agent.name)).toEqual([
    "Pixel",
  ]);
});

it("counts the viewer's agents whose usage no read here covers", async () => {
  const unfinished = { ...agent("Setup", "hosted"), unfinished: true } as Agent;
  const other = { ...agent("Other"), type: "example.other/agent" } as Agent;
  const list = [
    agent("Pixel"),
    agent("Hosted", "hosted"),
    agent("Laptop", "elsewhere"),
    other,
    unfinished,
  ];
  const store = todayStore(
    host(list, async () => [session("s", noon - 60_000, 1)]),
    () => noon,
  );
  await store.refresh();
  // Hosted, on another device, and a type that reads no usage; an unfinished
  // setup is not an agent yet.
  expect(store.get()?.excluded).toBe(3);
  expect(store.get()?.result.cost).toEqual({ value: 1, partial: false });
  // The same object while nothing changes, as useSyncExternalStore needs.
  expect(store.get()).toBe(store.get());
});

it("updates the excluded count without reading again", async () => {
  const list = [agent("Pixel")];
  const usage = vi.fn(async () => [session("s", noon - 60_000, 1)]);
  const store = todayStore(host(list, usage), () => noon);
  await store.refresh();
  const before = store.get();
  expect(before?.excluded).toBe(0);
  list.push(agent("Laptop", "elsewhere"));
  const after = store.get();
  expect(after?.excluded).toBe(1);
  expect(after).not.toBe(before);
  expect(after?.result).toBe(before?.result);
  expect(usage).toHaveBeenCalledTimes(1);
});

it("shares one read between composers until it goes stale", async () => {
  let now = noon;
  let reads = 0;
  const store = todayStore(
    host([agent("Pixel")], async () => {
      reads += 1;
      return [session("s", noon, 1)];
    }),
    () => now,
  );
  await Promise.all([store.refresh(), store.refresh()]);
  await store.refresh();
  expect(reads).toBe(1);
  now += FRESH_MS;
  await store.refresh();
  expect(reads).toBe(2);
});

it("keeps what an earlier read found when a read fails, marked partial", async () => {
  let now = noon;
  let fail = false;
  const store = todayStore(
    host([agent("Pixel")], async () => {
      if (fail) throw new Error("busy");
      return [session("s", noon, 2)];
    }),
    () => now,
  );
  await store.refresh();
  fail = true;
  now += FRESH_MS;
  await store.refresh();
  expect(store.get()?.result.cost).toEqual({ value: 2, partial: true });
});

it("drops sessions from before midnight on the first read of a new day", async () => {
  let now = noon;
  let sessions = [session("s", noon, 3)];
  const store = todayStore(
    host([agent("Pixel")], async () => sessions),
    () => now,
  );
  await store.refresh();
  now = dayStart(noon) + 36 * 60 * 60 * 1000;
  sessions = [];
  await store.refresh();
  expect(store.get()?.result.cost).toEqual({ value: 0, partial: false });
  expect(store.get()?.result.agents).toEqual([]);
});

it("aborts a running read when disposed and shows nothing from it", async () => {
  let signal: AbortSignal | undefined;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = todayStore(
    host([agent("Pixel")], async (_, options) => {
      signal = options.signal;
      await held;
      return [session("s", noon, 1)];
    }),
    () => noon,
  );
  const reading = store.refresh();
  await vi.waitFor(() => expect(signal).toBeDefined());
  store.dispose();
  expect(signal?.aborted).toBe(true);
  release();
  await reading;
  expect(store.get()).toBeUndefined();
});

it("opens an agent's latest session today that started in a conversation", async () => {
  const pixel = agent("Pixel");
  const store = todayStore(
    host([pixel], async () => [
      session("early", noon - 120_000, 1),
      { ...session("late", noon - 60_000, 1), root: "r".repeat(64) },
      unplaced(session("solo", noon, 1)),
    ]),
    () => noon,
  );
  await store.refresh();
  const today = store.get();
  expect(today && latestSession(today, pixel)?.id).toBe("late");
});

afterEach(() => {
  vi.useRealTimers();
});

/** Agents whose snapshot the test changes, telling subscribers. */
function live(usage: RegisteredAgentType["usage"]) {
  let snapshot = {
    status: "loading",
    agents: [],
    running: [],
  } as unknown as AgentsSnapshot;
  const listeners = new Set<() => void>();
  const types = [
    { key: "buzz.claude-code/claude", title: "Claude", usage },
  ] as unknown as RegisteredAgentType[];
  return {
    agents: {
      snapshot: () => snapshot,
      types: () => types,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as Agents,
    set(list: Agent[]) {
      snapshot = {
        status: "ready",
        agents: list,
        running: list,
      } as unknown as AgentsSnapshot;
      for (const listener of listeners) listener();
    },
    /** As while the community reconnects. */
    loading() {
      snapshot = { ...snapshot, status: "loading" } as AgentsSnapshot;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

it("reads once the agents load, when a composer asked before they had", async () => {
  const reads = vi.fn(async () => [session("s", noon, 1)]);
  const host = live(reads);
  const store = todayStore(host.agents, () => noon);
  const stop = store.subscribe(() => {});
  expect(store.refresh()).toBeUndefined();
  host.set([agent("Pixel")]);
  await vi.waitFor(() => expect(store.get()?.agents).toBe(1));
  expect(reads).toHaveBeenCalledTimes(1);
  stop();
  expect(host.listeners.size).toBe(0);
});

it("reads a new agent at once, even while the last read is fresh", async () => {
  const host = live(async () => [session("s", noon, 1)]);
  const store = todayStore(host.agents, () => noon);
  store.subscribe(() => {});
  host.set([agent("Pixel")]);
  await vi.waitFor(() => expect(store.get()?.agents).toBe(1));
  host.set([agent("Pixel"), agent("Fizz")]);
  await vi.waitFor(() => expect(store.get()?.agents).toBe(2));
  expect(store.get()?.result.cost).toEqual({ value: 2, partial: false });
});

it("turns over at local midnight without another trigger", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(noon);
  let sessions = [session("s", noon, 3)];
  const store = todayStore(host([agent("Pixel")], async () => sessions));
  store.subscribe(() => {});
  await store.refresh();
  expect(store.get()?.result.cost).toEqual({ value: 3, partial: false });
  sessions = [];
  await vi.advanceTimersByTimeAsync(dayStart(noon, -1) - noon);
  await vi.waitFor(() =>
    expect(store.get()?.result.cost).toEqual({ value: 0, partial: false }),
  );
});

it("stops watching when no composer shows it", async () => {
  const host = live(async () => []);
  const store = todayStore(host.agents, () => noon);
  const stop = store.subscribe(() => {});
  expect(host.listeners.size).toBe(1);
  stop();
  expect(host.listeners.size).toBe(0);
});

it("shows no other community's total while it reads the one now selected", async () => {
  let answer: ((sessions: SessionUsage[]) => void) | undefined;
  let held = false;
  const host = live(async () =>
    held
      ? new Promise<SessionUsage[]>((resolve) => {
          answer = resolve;
        })
      : [session("s", noon, 5)],
  );
  const store = todayStore(host.agents, () => noon);
  const stop = store.subscribe(() => {});
  host.set([agent("Pixel"), agent("Ledger")]);
  await vi.waitFor(() => expect(store.get()?.agents).toBe(2));
  held = true;
  host.set([agent("Fizz")]);
  expect(store.get()).toBeUndefined();
  await vi.waitFor(() => expect(answer).toBeDefined());
  answer?.([session("s", noon, 1)]);
  await vi.waitFor(() => expect(store.get()?.agents).toBe(1));
  expect(store.get()?.result.cost).toEqual({ value: 1, partial: false });
  stop();

  // With no composer watching, the next one to show reads at once.
  held = false;
  host.set([agent("Pixel")]);
  expect(store.get()).toBeUndefined();
  await store.refresh();
  expect(store.get()?.result.agents.map((entry) => entry.agent.name)).toEqual([
    "Pixel",
  ]);
});

it("reads again when an agent's configuration changes", async () => {
  const reads = vi.fn(async () => [session("s", noon, 1)]);
  const host = live(reads);
  const store = todayStore(host.agents, () => noon);
  store.subscribe(() => {});
  host.set([agent("Pixel")]);
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
  host.set([
    { ...agent("Pixel"), config: { workspace: "/elsewhere" } } as Agent,
  ]);
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
});

it("shows no total from an earlier day", async () => {
  let now = noon;
  const store = todayStore(
    host([agent("Pixel")], async () => [session("s", noon, 3)]),
    () => now,
  );
  await store.refresh();
  now = dayStart(noon, -1) + 9 * 3_600_000;
  expect(store.get()).toBeUndefined();
});

it("turns over once the agents are back, when they were not at midnight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(noon);
  const reads = vi.fn(async () => [session("s", Date.now(), 3)]);
  const host = live(reads);
  const store = todayStore(host.agents);
  store.subscribe(() => {});
  host.set([agent("Pixel")]);
  await vi.waitFor(() => expect(store.get()?.agents).toBe(1));
  host.loading();
  await vi.advanceTimersByTimeAsync(dayStart(noon, -1) - noon);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(store.get()).toBeUndefined();
  host.set([agent("Pixel")]);
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(store.get()?.now).toBeGreaterThanOrEqual(dayStart(noon, -1)),
  );
});

/** A host whose Claude type reports Pixel's one session: `at` moves as a
 * message comes in or a turn ends, and `status` says whether a turn runs. */
function working(usage: RegisteredAgentType["usage"]) {
  let report: { at?: number; status?: string } = {};
  const listeners = new Set<() => void>();
  const snapshot = {
    status: "ready",
    agents: [agent("Pixel")],
    running: [],
  } as unknown as AgentsSnapshot;
  const sessions = {
    list: () => [{ channelId: "chan", ...report }],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const types = [
    { key: "buzz.claude-code/claude", title: "Claude", usage, sessions },
  ] as unknown as RegisteredAgentType[];
  const tell = (next: typeof report) => {
    report = next;
    for (const listener of listeners) listener();
  };
  return {
    agents: {
      snapshot: () => snapshot,
      types: () => types,
      subscribe: () => () => {},
    } as unknown as Agents,
    /** A message comes in and a turn starts. */
    start: () => tell({ at: Date.now(), status: "Working" }),
    /** The turn ends. */
    end: () => tell({ at: Date.now(), status: "Idle" }),
    /** A type that reports no status: only `at` moves. */
    moved: () => tell({ at: Date.now() }),
    /** Its type reports again with nothing changed. */
    notify: () => tell(report),
    listeners,
  };
}

async function watched(usd = () => 1) {
  vi.useFakeTimers();
  vi.setSystemTime(noon);
  const reads = vi.fn(async () => [session("s", noon, usd())]);
  const host = working(reads);
  const store = todayStore(host.agents);
  const stop = store.subscribe(() => {});
  await store.refresh();
  expect(reads).toHaveBeenCalledTimes(1);
  return { reads, host, store, stop };
}

it("reads again shortly after a turn ends, without a composer or window change", async () => {
  let usd = 1;
  const { reads, host, store } = await watched(() => usd);
  host.start();
  await vi.advanceTimersByTimeAsync(5_000);
  usd = 3;
  host.end();
  await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
  expect(reads).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(reads).toHaveBeenCalledTimes(2);
  await vi.waitFor(() =>
    expect(store.get()?.result.cost).toEqual({ value: 3, partial: false }),
  );
});

it("reads nothing as a message comes in, so the turn's end reads at once", async () => {
  const { reads, host } = await watched();
  host.start();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
  expect(reads).toHaveBeenCalledTimes(1);
});

it("reads at most once every TURN_GAP_MS while turns keep ending", async () => {
  const { reads, host } = await watched();
  host.start();
  host.end();
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  expect(reads).toHaveBeenCalledTimes(2);
  // Three more turns end soon after: one read covers them, TURN_GAP_MS after
  // the last read.
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    host.start();
    host.end();
  }
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS - 3_000 - 1);
  expect(reads).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(reads).toHaveBeenCalledTimes(3);
  // Nothing more ends: no further reads.
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS * 3);
  expect(reads).toHaveBeenCalledTimes(3);
});

it("reads once more when a turn ends just before a read it may have missed", async () => {
  const { reads, host } = await watched();
  host.start();
  host.end();
  await vi.advanceTimersByTimeAsync(SETTLE_MS / 2);
  host.start();
  host.end();
  await vi.advanceTimersByTimeAsync(SETTLE_MS / 2);
  expect(reads).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
  expect(reads).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS * 3);
  expect(reads).toHaveBeenCalledTimes(3);
});

it("reads when `at` moves for a type that reports no status", async () => {
  const { reads, host } = await watched();
  host.moved();
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  expect(reads).toHaveBeenCalledTimes(2);
});

it("ignores session reports that end no turn", async () => {
  const { reads, host } = await watched();
  host.notify();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
  expect(reads).toHaveBeenCalledTimes(1);
});

it("stops hearing sessions, and reads nothing pending, when no composer shows it", async () => {
  const { reads, host, stop } = await watched();
  expect(host.listeners.size).toBe(1);
  host.start();
  host.end();
  stop();
  expect(host.listeners.size).toBe(0);
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
  expect(reads).toHaveBeenCalledTimes(1);
});
