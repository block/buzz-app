import { yieldToHost } from "./yield";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import type { ReadFilter, RelayEvent } from "./events";
import type { ReadTransport } from "./transport";
import { byteSize } from "./budget";
import { ReadError } from "./errors";

export type Priority = "foreground" | "background";
export type ReadOptions = {
  signal?: AbortSignal;
  priority?: Priority;
  /** A write preflight must start after its intent, never join an older in-flight read. */
  fresh?: boolean;
};
/** Finite, verified event reads. No retained event cache or claim of live freshness. */
export type RelayReader = {
  read(
    filters: readonly ReadFilter[],
    options?: ReadOptions,
  ): Promise<readonly RelayEvent[]>;
};
type Consumer = {
  resolve(events: readonly RelayEvent[]): void;
  reject(error: unknown): void;
};
type Job = {
  id: string;
  queued: (outcome?: "ok" | "error") => void;
  fetched?: ((outcome?: "ok" | "error") => void) | undefined;
  key: string;
  filters: readonly ReadFilter[];
  priority: Priority;
  controller: AbortController;
  consumers: Set<Consumer>;
  timer: ReturnType<typeof setTimeout>;
  running: boolean;
};
const cancelled = () => new DOMException("Relay read cancelled", "AbortError");

/** Session-owned scheduling and cancellation. Equal concurrent reads share work;
 * cancelling one consumer never cancels another. Completion releases all request state. */
export function createRelayReader(
  transport: ReadTransport | null,
  {
    timeoutMs = 10_000,
    maxPending = 128,
    profiling = createRelayProfiler(),
  }: {
    timeoutMs?: number;
    maxPending?: number;
    profiling?: RelayProfiler;
  } = {},
) {
  if (
    !Number.isFinite(timeoutMs) ||
    !(timeoutMs > 0) ||
    !Number.isInteger(maxPending) ||
    maxPending < 1
  )
    throw new Error("Invalid relay read budget");
  let sequence = 0;
  const jobs = new Map<string, Job>();
  let closed = false;
  let recovering = false;
  function failed(job: Job, error: unknown) {
    if (jobs.get(job.key) !== job) return;
    // A browser can reject fetches while its document loader is stopping.
    // Settle immediately, but do not start another read in that callback stack
    // (including through consumer cancellation/retry). A microtask is too early.
    if (!recovering) {
      recovering = true;
      void yieldToHost().then(() => {
        recovering = false;
        pump();
      });
    }
    finish(job, undefined, error);
  }
  function finish(job: Job, events?: readonly RelayEvent[], error?: unknown) {
    if (jobs.get(job.key) !== job) return;
    job.queued(error ? "error" : "ok");
    job.fetched?.(error ? "error" : "ok");
    jobs.delete(job.key);
    clearTimeout(job.timer);
    job.controller.abort();
    for (const consumer of job.consumers) {
      if (events) consumer.resolve(events);
      else consumer.reject(error);
    }
    job.consumers.clear();
    pump();
  }
  function pump() {
    if (closed || recovering || !transport) return;
    while (!recovering) {
      const active = [...jobs.values()].filter((job) => job.running);
      if (active.length >= 3) return;
      const background = active.some((job) => job.priority === "background");
      const queued = [...jobs.values()].filter((job) => !job.running);
      const job =
        queued.find((job) => job.priority === "foreground") ??
        (!background ? queued[0] : undefined);
      if (!job) return;
      job.running = true;
      job.queued();
      job.fetched = profiling.start("read.fetch", job.id);
      // Catch synchronous adapter failures as well as rejected promises.
      try {
        void transport
          .query(job.filters, job.controller.signal, job.id, job.priority)
          .then(
            (events) => {
              if (byteSize(events) > 8 * 1024 * 1024)
                finish(
                  job,
                  undefined,
                  new ReadError(
                    "invalid-response",
                    "Relay response exceeds the read budget",
                  ),
                );
              else finish(job, Object.freeze([...events]));
            },
            (error) => failed(job, error),
          );
      } catch (error) {
        failed(job, error);
      }
    }
  }
  const reader: RelayReader = Object.freeze({
    read(
      filters: readonly ReadFilter[],
      { signal, priority = "foreground", fresh = false }: ReadOptions = {},
    ) {
      if (closed || signal?.aborted) return Promise.reject(cancelled());
      if (!transport)
        return Promise.reject(
          new ReadError("unavailable", "Relay is disconnected"),
        );
      let key: string;
      try {
        if (!filters.length || filters.length > 4)
          throw new Error("A read needs 1–4 filters");
        // Object property and set order do not change NIP-01 filter semantics.
        key = JSON.stringify(
          filters.map((filter) => {
            if (
              !(
                filter.kinds?.length &&
                filter.kinds.every(
                  (kind) =>
                    Number.isInteger(kind) && kind >= 0 && kind <= 65535,
                )
              ) &&
              !(filter.kinds === undefined && filter.ids?.length)
            )
              throw new Error("Relay reads need valid kinds or event IDs");
            if (
              !Number.isInteger(filter.limit) ||
              filter.limit < 1 ||
              filter.limit > 500
            )
              throw new Error("Relay read limit must be between 1 and 500");
            return Object.fromEntries(
              Object.entries(filter)
                .filter(([, value]) => value !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, value]) => [
                  name,
                  Array.isArray(value) &&
                  (name === "kinds" ||
                    name === "authors" ||
                    name === "ids" ||
                    name.startsWith("#"))
                    ? [...new Set(value)].sort()
                    : value,
                ]),
            );
          }),
        );
        if (new TextEncoder().encode(key).byteLength > 64 * 1024)
          throw new Error("Relay filters exceed the request budget");
      } catch (error) {
        return Promise.reject(error);
      }
      const requestFilters = JSON.parse(key);
      if (fresh) key = `${key}:fresh:${++sequence}`;
      let job = jobs.get(key);
      if (!job) {
        if (jobs.size >= maxPending)
          return Promise.reject(
            new ReadError("unavailable", "Too many pending relay reads"),
          );
        const id = `read:${++sequence}`;
        job = {
          id,
          queued: profiling.start("read.queue", id),
          key,
          filters: requestFilters,
          priority,
          controller: new AbortController(),
          consumers: new Set(),
          running: false,
          timer: setTimeout(
            () =>
              finish(
                owned,
                undefined,
                new ReadError("unavailable", "Relay read timed out"),
              ),
            timeoutMs,
          ),
        };
        jobs.set(key, job);
      } else if (!job.running && priority === "foreground")
        job.priority = priority;
      const owned = job;
      return new Promise<readonly RelayEvent[]>((resolve, reject) => {
        const release = () => signal?.removeEventListener("abort", abort);
        const consumer: Consumer = {
          resolve(events) {
            release();
            resolve(events);
          },
          reject(error) {
            release();
            reject(error);
          },
        };
        const abort = () => {
          owned.consumers.delete(consumer);
          consumer.reject(cancelled());
          if (!owned.consumers.size) finish(owned, undefined, cancelled());
        };
        owned.consumers.add(consumer);
        signal?.addEventListener("abort", abort, { once: true });
        pump();
      });
    },
  });
  return {
    reader,
    /** Promote existing queued work without creating a consumer or a new deadline. */
    promote(matches: (filters: readonly ReadFilter[]) => boolean) {
      for (const job of jobs.values())
        if (!job.running && matches(job.filters)) job.priority = "foreground";
      pump();
    },
    invalidate(
      matches: (filters: readonly ReadFilter[]) => boolean = () => true,
    ) {
      // Stop pumping until the whole invalidation has removed its queued work.
      const previous = closed;
      closed = true;
      for (const job of [...jobs.values()])
        if (matches(job.filters)) finish(job, undefined, cancelled());
      closed = previous;
      pump();
    },
    dispose() {
      closed = true;
      for (const job of [...jobs.values()]) finish(job, undefined, cancelled());
    },
  };
}
