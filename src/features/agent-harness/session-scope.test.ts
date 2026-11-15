import { SessionControls } from "./session-control";
import { expect, it, vi } from "vitest";
import { localStore } from "../agents/store";
import {
  COMMUNITY_SESSION,
  communityTurn,
  scopedSessionKey,
  sessionScope,
  rememberCommunitySource,
  sessionSource,
} from "./session-scope";

it("keeps old thread and channel keys and selects one community key across every source", () => {
  expect(scopedSessionKey("thread", "a", "root")).toBe("a/root");
  expect(scopedSessionKey("thread", "a")).toBe("a");
  expect(scopedSessionKey("channel", "a", "root")).toBe("a");
  for (const channel of ["a", "dm", "solo", "huddle"])
    expect(scopedSessionKey("community", channel, "root")).toBe(
      COMMUNITY_SESSION,
    );
  expect(sessionScope("community")).toBe("community");
  expect(sessionScope("unknown")).toBe("thread");
});

it("persists the navigation source separately for each community membership", async () => {
  const values = new Map<string, string>();
  const backing = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  } as Storage;
  const store = localStore(backing);
  await rememberCommunitySource(store, "agent", COMMUNITY_SESSION, "a");
  await rememberCommunitySource(
    store,
    "agent@other.example",
    COMMUNITY_SESSION,
    "b",
  );
  const reloaded = localStore(backing);
  expect(sessionSource(reloaded, "agent", COMMUNITY_SESSION)).toEqual({
    channelId: "a",
    community: true,
  });
  expect(
    sessionSource(reloaded, "agent@other.example", COMMUNITY_SESSION),
  ).toEqual({ channelId: "b", community: true });
});

it("releases an expired admission while preserving the prior ordering barrier", async () => {
  let release!: () => void;
  const previous = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policies = new Map([
    [
      COMMUNITY_SESSION,
      { topLevel: false, handed: previous, settled: previous, cancel() {} },
    ],
  ]);
  const signal = new AbortController();
  const controls = new SessionControls(() => {});
  const run = vi.fn(async () => "ran");
  const first = communityTurn(policies, signal.signal, controls, "shared", run);
  const rejected = vi.fn();
  void first.catch(rejected);
  signal.abort(new Error("expired"));
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalled());
    const next = communityTurn(
      policies,
      new AbortController().signal,
      controls,
      "shared",
      run,
    );
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    release();
    await expect(next).resolves.toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await first.catch(() => {});
  }
});

it("cancels prior queued policies when the shared session is interrupted", async () => {
  let release!: () => void;
  const previous = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.fn();
  const policies = new Map([
    [
      COMMUNITY_SESSION,
      { topLevel: false, handed: previous, settled: previous, cancel },
    ],
  ]);
  const turn = communityTurn(
    policies,
    new AbortController().signal,
    new SessionControls(() => {}),
    "shared",
    async () => {},
  );
  void turn.catch(() => {});
  try {
    policies.get(COMMUNITY_SESSION)?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    release();
    await turn.catch(() => {});
  }
});
