import { expect, it } from "vitest";
import { localStore } from "../agents/store";
import {
  COMMUNITY_SESSION,
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
