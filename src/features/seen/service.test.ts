import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeenService } from "./service";

const key = "example.plugin/welcome";
const storageKey = "buzz.seen.v1:alice";
const roots: Context[] = [];
const disk = new Map<string, string>();
const windowEvents = new EventTarget();
const read = vi.fn((key: string) => disk.get(key) ?? null);
const write = vi.fn((key: string, value: string) => disk.set(key, value));

function windowFor(viewer?: string) {
  const root = new Context();
  roots.push(root);
  const listeners = new Set<() => void>();
  new SeenService(root, {
    snapshot: () => (viewer ? { viewer } : {}),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    seen: root.seen,
    identify(next?: string) {
      viewer = next;
      for (const listener of listeners) listener();
    },
  };
}

function storageChanged(key: string | null) {
  windowEvents.dispatchEvent(Object.assign(new Event("storage"), { key }));
}

beforeEach(() => {
  disk.clear();
  read.mockClear();
  write.mockClear();
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("localStorage", { getItem: read, setItem: write });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllGlobals();
});

it("isolates each identity and restores its marks", () => {
  const { seen, identify } = windowFor();
  expect(seen.has(key)).toBeUndefined();
  seen.mark(key);
  expect(write).not.toHaveBeenCalled();

  identify("alice");
  expect(seen.has(key)).toBe(false);
  seen.mark(key);
  seen.mark(key);
  expect(seen.has(key)).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith(
    storageKey,
    JSON.stringify([key]),
  );

  identify("bob");
  expect(seen.has(key)).toBe(false);
  identify();
  expect(seen.has(key)).toBeUndefined();
  identify("alice");
  expect(seen.has(key)).toBe(true);
  expect(windowFor("alice").seen.has(key)).toBe(true);
});

it("updates subscribers for the active identity when another window saves", () => {
  const { seen } = windowFor("alice");
  const changes = vi.fn(() => seen.has(key));
  const stop = seen.subscribe(changes);
  const peer = windowFor("alice").seen;
  peer.mark(key);
  storageChanged("buzz.seen.v1:bob");
  expect(changes).not.toHaveBeenCalled();
  storageChanged(storageKey);
  expect(changes).toHaveReturnedWith(true);

  stop();
  disk.clear();
  storageChanged(null);
  expect(changes).toHaveBeenCalledOnce();
  expect(seen.has(key)).toBe(false);
});

it("merges concurrent marks under the same window lock", async () => {
  let tail = Promise.resolve();
  const request = vi.fn((_key: string, run: () => void) => {
    tail = tail.then(run);
    return tail;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  const first = windowFor("alice").seen;
  const second = windowFor("alice").seen;
  first.mark(key);
  second.mark("example.plugin/another");
  expect(first.has(key)).toBe(true);
  expect(second.has(key)).toBe(false);
  await tail;
  expect(request.mock.calls.map(([key]) => key)).toEqual([
    storageKey,
    storageKey,
  ]);
  expect(JSON.parse(disk.get(storageKey) ?? "null")).toEqual([
    key,
    "example.plugin/another",
  ]);
});

it("keeps absence unknown when storage fails and retries unsaved marks", () => {
  read.mockImplementationOnce(() => {
    throw new Error("Denied");
  });
  const { seen } = windowFor("alice");
  expect(seen.has(key)).toBeUndefined();
  write.mockImplementationOnce(() => {
    throw new Error("Quota exceeded");
  });
  seen.mark(key);
  expect(seen.has(key)).toBe(true);
  expect(disk.has(storageKey)).toBe(false);
  seen.mark(key);
  expect(windowFor("alice").seen.has(key)).toBe(true);
});

it("accepts open names up to 96 characters", () => {
  const { seen } = windowFor("alice");
  const longest = `example.plugin/${"💡".repeat(81)}`;
  const tooLong = `${longest}!`;
  for (const invalid of ["unnamespaced", "example.plugin/", tooLong]) {
    seen.mark(invalid);
    expect(seen.has(invalid)).toBeUndefined();
  }
  expect(write).not.toHaveBeenCalled();
  seen.mark(longest);
  expect(seen.has(longest)).toBe(true);
});
