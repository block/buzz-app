import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubError } from "./github";
import { createQueueCache } from "./queueCache";
import { createTokenStore } from "./tokenStore";
import type { SearchResult } from "./types";

type Item = { id: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function setup(
  fetcher: (token: string, signal: AbortSignal) => Promise<SearchResult<Item>>,
) {
  const tokenStore = createTokenStore();
  tokenStore.setToken("first-token");
  const cache = createQueueCache(tokenStore, fetcher, "Could not load queue.");
  return { cache, tokenStore };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createQueueCache", () => {
  it("loads once and treats an empty result as cached", async () => {
    const fetcher = vi.fn(async () => ({ items: [], truncated: false }));
    const { cache } = setup(fetcher);

    await cache.load();
    const snapshot = cache.snapshot();
    await cache.load();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshot.result).toEqual({ items: [], truncated: false });
    expect(cache.snapshot()).toBe(snapshot);
    cache.dispose();
  });

  it("shares one pending request across load and refresh", async () => {
    const request = deferred<SearchResult<Item>>();
    const { cache } = setup(() => request.promise);

    const load = cache.load();
    const refresh = cache.refresh();

    expect(refresh).toBe(load);
    expect(cache.snapshot().isFetching).toBe(true);
    request.resolve({ items: [{ id: 1 }], truncated: false });
    await load;
    cache.dispose();
  });

  it("publishes immutable snapshots to subscribers", async () => {
    const request = deferred<SearchResult<Item>>();
    const { cache } = setup(() => request.promise);
    const initial = cache.snapshot();
    const listener = vi.fn();
    cache.subscribe(listener);

    const load = cache.load();
    const pending = cache.snapshot();
    request.resolve({ items: [{ id: 1 }], truncated: false });
    await load;

    expect(pending).not.toBe(initial);
    expect(cache.snapshot()).not.toBe(pending);
    expect(listener).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("updates the timestamp after a successful refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetcher = vi
      .fn<() => Promise<SearchResult<Item>>>()
      .mockResolvedValueOnce({ items: [{ id: 1 }], truncated: false })
      .mockResolvedValueOnce({ items: [{ id: 2 }], truncated: true });
    const { cache } = setup(fetcher);

    await cache.load();
    vi.setSystemTime(2_000);
    await cache.refresh();

    expect(cache.snapshot()).toEqual({
      result: { items: [{ id: 2 }], truncated: true },
      isFetching: false,
      error: null,
      lastFetchedAt: 2_000,
    });
    cache.dispose();
  });

  it("keeps cached data and its timestamp when refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetcher = vi
      .fn<() => Promise<SearchResult<Item>>>()
      .mockResolvedValueOnce({ items: [{ id: 1 }], truncated: false })
      .mockRejectedValueOnce(new GitHubError("GitHub is unavailable."));
    const { cache } = setup(fetcher);

    await cache.load();
    vi.setSystemTime(2_000);
    await cache.refresh();

    expect(cache.snapshot()).toEqual({
      result: { items: [{ id: 1 }], truncated: false },
      isFetching: false,
      error: "GitHub is unavailable.",
      lastFetchedAt: 1_000,
    });
    cache.dispose();
  });

  it("does not retry an initial failure until refresh", async () => {
    const fetcher = vi
      .fn<() => Promise<SearchResult<Item>>>()
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValueOnce({ items: [{ id: 1 }], truncated: false });
    const { cache } = setup(fetcher);

    await cache.load();
    await cache.load();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.snapshot().error).toBe("Could not load queue.");

    await cache.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.snapshot().result?.items).toEqual([{ id: 1 }]);
    cache.dispose();
  });

  it("resets on token change and ignores a late request from the old token", async () => {
    const oldRequest = deferred<SearchResult<Item>>();
    const newRequest = deferred<SearchResult<Item>>();
    const signals: AbortSignal[] = [];
    const { cache, tokenStore } = setup((token, signal) => {
      signals.push(signal);
      return token === "first-token" ? oldRequest.promise : newRequest.promise;
    });

    const oldLoad = cache.load();
    tokenStore.setToken("second-token");
    expect(signals[0]?.aborted).toBe(true);
    expect(cache.snapshot()).toEqual({
      result: null,
      isFetching: false,
      error: null,
      lastFetchedAt: null,
    });

    const newLoad = cache.load();
    oldRequest.resolve({ items: [{ id: 1 }], truncated: false });
    await oldLoad;
    expect(cache.snapshot().isFetching).toBe(true);
    expect(cache.snapshot().result).toBeNull();

    newRequest.resolve({ items: [{ id: 2 }], truncated: false });
    await newLoad;
    expect(cache.snapshot().result?.items).toEqual([{ id: 2 }]);
    cache.dispose();
  });

  it("clears and cancels work on dispose without publishing late results", async () => {
    const request = deferred<SearchResult<Item>>();
    let signal: AbortSignal | undefined;
    const { cache } = setup((_token, nextSignal) => {
      signal = nextSignal;
      return request.promise;
    });
    const listener = vi.fn();
    cache.subscribe(listener);

    const load = cache.load();
    cache.dispose();
    expect(signal?.aborted).toBe(true);
    expect(cache.snapshot().result).toBeNull();

    request.resolve({ items: [{ id: 1 }], truncated: false });
    await load;
    await cache.load();
    expect(cache.snapshot().result).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
