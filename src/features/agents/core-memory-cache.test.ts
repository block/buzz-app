import { afterEach, expect, it, vi } from "vitest";
import { CoreMemoryCache, forgetCoreMemory } from "./core-memory-cache";
import type { AgentReads, MemoryListing } from "./reads";

const agent = "a".repeat(64);
const listing = (body?: string, partial = false): MemoryListing => ({
  entries: body === undefined ? [] : [{ slug: "core", body, createdAt: 1 }],
  partial,
});

function setup() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
  const memoryListing = vi.fn(async (_signal: AbortSignal) => listing("one"));
  let reads: AgentReads | undefined = {
    connection: {},
    scope: "wss://one.test",
    memoryListing,
  } as unknown as AgentReads;
  const cache = new CoreMemoryCache(() => reads, storage);
  return {
    cache,
    data,
    memoryListing,
    storage,
    /** Replaces the connection, which may read as someone else. */
    reconnect(read = memoryListing, scope = "wss://one.test") {
      reads = {
        connection: {},
        scope,
        memoryListing: read,
      } as unknown as AgentReads;
    },
  };
}

function held() {
  let release!: (value: MemoryListing) => void;
  const promise = new Promise<MemoryListing>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => vi.restoreAllMocks());

it("waits on one read with nothing cached, then answers from the cache with none", async () => {
  const f = setup();
  await expect(f.cache.core(agent)).resolves.toBe("one");
  await expect(f.cache.core(agent)).resolves.toBe("one");
  expect(f.memoryListing).toHaveBeenCalledOnce();
  // A new cache on the same storage, as after a restart, reads nothing.
  const restarted = new CoreMemoryCache(
    () =>
      ({
        connection: {},
        scope: "wss://one.test",
        memoryListing: f.memoryListing,
      }) as unknown as AgentReads,
    f.storage,
  );
  await expect(restarted.core(agent)).resolves.toBe("one");
  expect(f.memoryListing).toHaveBeenCalledOnce();
});

it("shares one read between concurrent starts with nothing cached", async () => {
  const f = setup();
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  const starts = Promise.all(
    Array.from({ length: 5 }, () => f.cache.core(agent)),
  );
  read.release(listing("shared"));
  await expect(starts).resolves.toEqual(Array(5).fill("shared"));
  expect(f.memoryListing).toHaveBeenCalledOnce();
});

it("keeps what the agent wrote over a read that started before it", async () => {
  const f = setup();
  await f.cache.core(agent);
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  f.cache.refresh(agent);
  f.cache.wrote(agent, "core", "written");
  read.release(listing("stale"));
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  await expect(f.cache.core(agent)).resolves.toBe("written");
});

it("keeps what the agent wrote when this device cannot save it", async () => {
  const f = setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  f.storage.setItem = () => {
    throw new Error("quota");
  };
  f.cache.wrote(agent, "core", "written");
  await expect(f.cache.core(agent)).resolves.toBe("written");
  expect(f.memoryListing).not.toHaveBeenCalled();
});

it("leaves the cached copy when a refresh fails or its listing is partial", async () => {
  const f = setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await f.cache.core(agent);
  f.memoryListing.mockRejectedValueOnce(new Error("offline"));
  f.cache.refresh(agent);
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledTimes(2));
  f.memoryListing.mockResolvedValueOnce(listing(undefined, true));
  f.cache.refresh(agent);
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  await expect(f.cache.core(agent)).resolves.toBe("one");
});

it("does not declare core missing from a partial first listing", async () => {
  const f = setup();
  f.memoryListing.mockResolvedValue(listing(undefined, true));
  await expect(f.cache.core(agent)).resolves.toBeUndefined();
  await expect(f.cache.core(agent)).resolves.toBeUndefined();
  expect(f.memoryListing).toHaveBeenCalledTimes(2);
});

it("keeps nothing a replaced connection read", async () => {
  const f = setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  const first = f.cache.core(agent);
  const fresh = vi.fn(async () => listing("new owner's"));
  f.reconnect(fresh);
  read.release(listing("old owner's"));
  await expect(first).resolves.toBeUndefined();
  await expect(f.cache.core(agent)).resolves.toBe("new owner's");
  expect(fresh).toHaveBeenCalledOnce();
});

it("keeps each community's copy apart", async () => {
  const f = setup();
  await f.cache.core(agent);
  f.reconnect(
    vi.fn(async () => listing("two")),
    "wss://two.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("two");
  f.reconnect(f.memoryListing, "wss://one.test");
  await expect(f.cache.core(agent)).resolves.toBe("one");
  f.reconnect(
    vi.fn(async () => listing("unused")),
    "wss://two.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("two");
  expect(f.memoryListing).toHaveBeenCalledOnce();
  expect([...f.data.keys()].sort()).toEqual([
    `buzz.core-memory.v1:wss://one.test:${agent}`,
    `buzz.core-memory.v1:wss://two.test:${agent}`,
  ]);
});

it("gives a start waiting on its first read what the agent wrote meanwhile", async () => {
  const f = setup();
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  const waiting = f.cache.core(agent);
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledOnce());
  f.cache.wrote(agent, "core", "new");
  read.release(listing("old"));
  await expect(waiting).resolves.toBe("new");
});

it("forgets a left community's copy, keeps it across a disconnect, and lets no held read restore it", async () => {
  const f = setup();
  await f.cache.core(agent);
  f.reconnect(
    vi.fn(async () => listing("two")),
    "wss://two.test",
  );
  await f.cache.core(agent);
  // A disconnect keeps the offline copy.
  f.reconnect(
    vi.fn(async () => listing("unused")),
    "wss://one.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("one");
  // A refresh is under way when the community is left.
  const read = held();
  f.reconnect(
    vi.fn(() => read.promise),
    "wss://one.test",
  );
  const refreshed = f.cache.refresh(agent);
  forgetCoreMemory("wss://one.test", f.storage);
  // The read finishes on the same connection: only the purge's fence keeps it out.
  read.release(listing("stale"));
  await refreshed;
  expect([...f.data.keys()]).toEqual([
    `buzz.core-memory.v1:wss://two.test:${agent}`,
  ]);
  // Rejoining reads it again rather than reusing the forgotten copy.
  const rejoin = vi.fn(async () => listing("fresh"));
  f.reconnect(rejoin, "wss://one.test");
  await expect(f.cache.core(agent)).resolves.toBe("fresh");
  expect(rejoin).toHaveBeenCalledOnce();
});
