/** Connection-scoped required-ancestry failures shared by the runtime and composer.
 * Weak ownership retires these with the reader's connection; no transcript is cached. */
type Failure = Readonly<{ reason: string }>;
const connections = new WeakMap<
  object,
  {
    failures: Map<string, Failure>;
    listeners: Set<() => void>;
  }
>();
function state(connection: object) {
  let current = connections.get(connection);
  if (!current) {
    current = { failures: new Map(), listeners: new Set() };
    connections.set(connection, current);
  }
  return current;
}
export const forkFailures = {
  get(connection: object, id: string) {
    return state(connection).failures.get(id);
  },
  subscribe(connection: object, listener: () => void) {
    const current = state(connection);
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
    };
  },
  report(connection: object, id: string, error: unknown) {
    const current = state(connection);
    current.failures.set(id, {
      reason: error instanceof Error ? error.message : String(error),
    });
    for (const listener of current.listeners) listener();
  },
  clear(connection: object, id: string, expected: Failure | undefined) {
    const current = state(connection);
    if (!expected || current.failures.get(id) !== expected) return;
    current.failures.delete(id);
    for (const listener of current.listeners) listener();
  },
};
