/** A display-only projection of the local and owner-authored relay inventory, not proof of
 * ownership, membership, custody or running state. No prompts/configuration. */
export type AgentLibrary = Readonly<{
  definitions: readonly Readonly<{
    id: string;
    name: string;
    avatar?: string;
  }>[];
  identities: readonly Readonly<{
    pubkey: string;
    name: string;
    avatar?: string;
    definitionId?: string;
  }>[];
}>;
/** A reader may return what its sources gave with `error` naming the one
 * that failed, and `retry: false` (on a result or a thrown error) when
 * reading again cannot fix the failure. `forget` drops anything it kept
 * between reads, as when the session's cache is cleared. */
export type AgentLibraryReader = ((
  signal: AbortSignal,
) => Promise<AgentLibrary & Readonly<{ error?: string; retry?: false }>>) &
  Readonly<{ forget?: () => void }>;
export type AgentLibrarySnapshot = AgentLibrary &
  Readonly<{
    status: "unavailable" | "idle" | "loading" | "ready" | "error";
    error?: string;
    /** A whole read was held: the rows are its, kept while a reread waits,
     * loads or failed, or a partial reread's, in which a failed source shows
     * its last rows. Agent choices count them as complete but not current. */
    stale?: true;
    /** A failed read will read again on its own: reading again can fix it
     * and something still needs the list. */
    retrying?: true;
  }>;
const empty = { definitions: Object.freeze([]), identities: Object.freeze([]) };

/** One artwork rule for every agent surface: an identity without its own art
 * shows its linked definition's art. Applied once where the snapshot is made. */
export function inheritDefinitionAvatars<T extends AgentLibrary>(
  library: T,
): T {
  const art = new Map(
    library.definitions.flatMap((row) =>
      row.avatar ? [[row.id, row.avatar] as const] : [],
    ),
  );
  // Keep reader extras such as a partial-source error.
  return {
    ...library,
    identities: library.identities.map((row) => {
      const avatar = row.avatar ?? art.get(row.definitionId ?? "");
      return avatar && avatar !== row.avatar ? { ...row, avatar } : row;
    }),
  };
}
/** Retry delays after failed reads: a ceiling of 2s doubling to 1 minute,
 * with equal jitter so clients that failed together do not retry together. */
export function libraryRetryDelay(failures: number, random = Math.random) {
  const ceiling = Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1));
  return ceiling * (0.5 + random() / 2);
}

export function createAgentLibrary(
  read: AgentLibraryReader | undefined,
  notify = (listener: () => void) => listener(),
) {
  let closed = false;
  const demands = new Set<object>();
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  /** Counts clears, so a read joined before a disconnect stays its own. */
  let generation = 0;
  /** The last read that returned every source, until the cache is cleared. */
  let whole: AgentLibrary | undefined;
  /** Failed reads in a row, for the retry backoff. */
  let failures = 0;
  /** The last read failed in a way reading again cannot fix. */
  let hard = false;
  /** The connection dropped; the reread after reconnecting is owed even if
   * a read finishes before the stream is back. */
  let dropped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let snapshot: AgentLibrarySnapshot = {
    ...empty,
    status: read ? "idle" : "unavailable",
  };
  const listeners = new Set<() => void>();
  const retries = (next: AgentLibrarySnapshot) =>
    !closed && !hard && demands.size > 0 && !!next.error;
  function publish(next: AgentLibrarySnapshot) {
    const { retrying: _retrying, ...rest } = next;
    snapshot = Object.freeze(
      retries(rest) ? { ...rest, retrying: true as const } : rest,
    );
    for (const listener of listeners) notify(listener);
  }
  /** Gaining the first demand or losing the last can change `retrying`. */
  function reflectDemand() {
    if (retries(snapshot) !== !!snapshot.retrying) publish(snapshot);
  }
  /** The kept whole read, marked stale, for a snapshot that is not current. */
  function kept(): Pick<AgentLibrarySnapshot, "stale"> {
    return whole ? { stale: true } : {};
  }
  function cancelRetry() {
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
  }
  const failed = () =>
    snapshot.status === "error" ||
    (snapshot.status === "ready" && !!snapshot.error);
  /** While anything needs the list, a failed or partial read tries again on
   * its own, so nobody has to press Retry. */
  function scheduleRetry() {
    if (
      closed ||
      !read ||
      hard ||
      retry !== undefined ||
      pending ||
      !demands.size
    )
      return;
    if (!failed()) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (!closed && demands.size && failed()) void refresh();
    }, libraryRetryDelay(failures));
  }
  /** Joins a read in flight, unless `fresh`: then it supersedes that read,
   * which may predate a change the caller just made, and that read's waiters
   * wait for the new one. */
  function refresh({ fresh = false } = {}): Promise<void> {
    if (closed || !read) return Promise.resolve();
    if (pending && !fresh) return pending;
    cancelRetry();
    controller?.abort();
    const owned = new AbortController();
    controller = owned;
    publish({ ...snapshot, status: "loading", ...kept() });
    pending = Promise.resolve()
      .then(() => {
        if (closed || owned.signal.aborted)
          throw new Error("Library read cancelled");
        return read(owned.signal);
      })
      .then((library) => {
        if (closed || owned.signal.aborted) return;
        const { retry: again, ...rows } = library;
        hard = again === false;
        if (rows.error) {
          failures++;
          publish({
            ...inheritDefinitionAvatars(rows),
            status: "ready",
            ...kept(),
          });
          return;
        }
        failures = 0;
        whole = rows;
        publish({ ...inheritDefinitionAvatars(rows), status: "ready" });
      })
      .catch((error: unknown) => {
        if (closed || owned.signal.aborted) return;
        hard =
          typeof error === "object" &&
          error !== null &&
          "retry" in error &&
          error.retry === false;
        failures++;
        publish({
          ...snapshot,
          status: "error",
          error:
            "Could not read agent inventory. Check the community connection and local library, then retry; saved data is unchanged.",
          ...kept(),
        });
      })
      .finally(() => {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
          scheduleRetry();
        }
      })
      // A superseded read's waiters follow the read that replaced it, so a
      // finished refresh always means current inventory.
      .then(() => (controller !== owned && pending ? pending : undefined));
    return pending;
  }
  function abort() {
    generation++;
    cancelRetry();
    controller?.abort();
    controller = undefined;
    pending = undefined;
  }
  /** Forgets every read, as when the session's cache is cleared. */
  function clear() {
    abort();
    read?.forget?.();
    whole = undefined;
    failures = 0;
    hard = false;
    dropped = false;
    publish({ ...empty, status: closed || !read ? "unavailable" : "idle" });
  }
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      refresh,
      retain({ refresh: refreshOnRetain = true } = {}) {
        const demand = {};
        demands.add(demand);
        reflectDemand();
        if (refreshOnRetain) void refresh();
        else scheduleRetry();
        return () => {
          demands.delete(demand);
          if (!demands.size) cancelRetry();
          reflectDemand();
        };
      },
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    clear,
    /** A dropped connection: reads in flight stop, and the shown rows stay
     * until the reread after reconnecting replaces them. */
    stale() {
      if (closed || !read) return clear();
      abort();
      // The reread after reconnecting is owed, and starts its backoff afresh.
      dropped = true;
      failures = 0;
      hard = false;
      const { error: _error, ...rest } = snapshot;
      publish({ ...rest, status: "idle", ...kept() });
    },
    reconnect() {
      // Initial establishment can follow a completed activation read. A real
      // disconnect marks this snapshot stale; only then is fresh inventory
      // needed, unless a source failed: a partial result is ready but not current.
      if (!demands.size) return;
      // After a drop, a read that began or ended while the stream was down
      // may have missed a change: read again.
      if (dropped) {
        dropped = false;
        void refresh({ fresh: true });
        return;
      }
      // A read in flight began before this connection: reuse it, and reread
      // once if it fails.
      const joined = generation;
      if (pending)
        void pending.then(() => {
          if (joined === generation && demands.size && failed()) void refresh();
        });
      else if (snapshot.status !== "ready" || snapshot.error) void refresh();
    },
    dispose() {
      closed = true;
      demands.clear();
      clear();
      listeners.clear();
    },
  };
}
