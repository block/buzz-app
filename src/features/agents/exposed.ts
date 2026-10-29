// What an agent type's UI reaches of its runtime. The runtime runs where the
// agents do, and its UI may be in another page, so the runtime serves topics
// and commands (its `expose`) and the UI reaches them over a link of its own
// type. Only JSON crosses: a value without a field comes back without it, and
// `undefined` comes back as `null`.
import type { Json, Link, Topic } from "./link";

/** The UI's link to its type's runtime. */
export type RuntimeLink = Pick<Link, "read" | "watch" | "call">;

type Store = Readonly<{
  snapshot(): unknown;
  subscribe(listener: () => void): () => void;
}>;

/** A store's value, as a topic. */
export const storeTopic =
  (store: Store): Topic =>
  () => ({
    get: () => (store.snapshot() ?? null) as Json,
    subscribe: (listener) => store.subscribe(listener),
  });

/** A read by key (the topic's arguments), as a topic that changes whenever
 * `subscribe` says something did. */
export const viewTopic =
  <Key>(
    subscribe: (listener: () => void) => () => void,
    read: (key: Key) => unknown,
  ): Topic =>
  (args) => ({
    get: () => (read(args as Key) ?? null) as Json,
    subscribe,
  });

/** The runtime's `topic`, as a store the UI reads: `initial` until its first
 * value arrives. It is watched from now on, so it is current when read
 * outside a render too. */
export function linkedStore<T>(link: RuntimeLink, topic: string, initial: T) {
  const listeners = new Set<() => void>();
  link.watch(topic, null, () => {
    for (const listener of [...listeners]) listener();
  });
  return {
    snapshot: () => (link.read(topic) as T | null | undefined) ?? initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The runtime's `topic` read by key: `initial` until the key's first value
 * arrives. Each key is watched from its first read on. */
export function linkedView<Key extends Json, T>(
  link: RuntimeLink,
  topic: string,
  initial: T,
) {
  const listeners = new Set<() => void>();
  const watched = new Set<string>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const watch = (key: Key) => {
    const id = JSON.stringify(key);
    if (!watched.has(id)) {
      watched.add(id);
      link.watch(topic, key, notify);
    }
  };
  return {
    read(key: Key): T {
      watch(key);
      return (link.read(topic, key) as T | null | undefined) ?? initial;
    },
    /** Whether the runtime's value for `key` has arrived, so `read` is not
     * just `initial` yet. */
    loaded(key: Key): boolean {
      watch(key);
      return link.read(topic, key) !== undefined;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A call that settles when `signal` aborts, rejecting with its reason. The
 * runtime's work goes on; its answer is dropped. */
export function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}
