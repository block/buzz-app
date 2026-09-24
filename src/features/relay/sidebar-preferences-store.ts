import type {
  SidebarPreferences,
  SidebarSortMode,
  SidebarSortMutator,
  SidebarMuteMutator,
} from "./sidebar-preferences";

type SortFailure = Readonly<{
  group: string;
  mode: SidebarSortMode;
  error: string;
}>;
type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  data?: SidebarPreferences;
  error?: string;
  sortErrors?: readonly SortFailure[];
}>;

/** One bounded account-preference projection per relay session, not per page. */
export function createSidebarPreferencesStore(
  read: (signal?: AbortSignal) => Promise<SidebarPreferences>,
  available: boolean,
  notify = (listener: () => void) => listener(),
  writeMute?: SidebarMuteMutator,
  writeSort?: SidebarSortMutator,
) {
  const listeners = new Set<() => void>();
  const empty = (): Snapshot =>
    Object.freeze({ status: available ? "idle" : "unsupported" });
  let snapshot = empty();
  let closed = false;
  let active:
    | { controller: AbortController; promise: Promise<void> }
    | undefined;
  let writeQueue = Promise.resolve();
  let writeLifetime = new AbortController();
  let mutation = 0;
  let generation = 0;
  let nextSortMutation = 0;
  const latestSort = new Map<string, number>();
  const failedSorts = new Map<string, SortFailure>();
  const pendingSorts = new Map<
    number,
    { group: string; mode: SidebarSortMode }
  >();
  let confirmedSort: Readonly<Record<string, SidebarSortMode>> = {};
  const withSort = (
    sort: Readonly<Record<string, SidebarSortMode>>,
    group: string,
    mode: SidebarSortMode,
  ) => {
    const next = { ...sort };
    if (mode === "alpha") delete next[group];
    else next[group] = mode;
    return next;
  };
  const withPendingSorts = (
    sort: Readonly<Record<string, SidebarSortMode>>,
  ) => {
    let next = sort;
    for (const pending of pendingSorts.values())
      next = withSort(next, pending.group, pending.mode);
    return next;
  };
  const retained = (data: SidebarPreferences): SidebarPreferences =>
    Object.freeze({
      sections: Object.freeze(
        data.sections.map((section) => Object.freeze({ ...section })),
      ),
      assignments: Object.freeze({ ...data.assignments }),
      starred: Object.freeze([...data.starred]),
      muted: Object.freeze([...data.muted]),
      ...(data.sort ? { sort: Object.freeze({ ...data.sort }) } : {}),
    });
  const publish = (next: Snapshot) => {
    const { sortErrors: _errors, ...state } = next;
    snapshot = Object.freeze({
      ...state,
      ...(failedSorts.size
        ? { sortErrors: Object.freeze([...failedSorts.values()]) }
        : {}),
    });
    for (const listener of listeners) notify(listener);
  };
  function refresh(): Promise<void> {
    if (closed || !available) return Promise.resolve();
    if (active) return active.promise;
    const controller = new AbortController();
    const refreshMutation = mutation;
    const job = { controller, promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(async () => {
      if (closed || controller.signal.aborted) return;
      try {
        const data = await read(controller.signal);
        if (
          closed ||
          controller.signal.aborted ||
          active !== job ||
          mutation !== refreshMutation
        )
          return;
        confirmedSort = { ...(data.sort ?? {}) };
        publish({
          status: "ready",
          data: retained(
            pendingSorts.size
              ? { ...data, sort: withPendingSorts(confirmedSort) }
              : data,
          ),
        });
      } catch (error) {
        if (
          !closed &&
          !controller.signal.aborted &&
          active === job &&
          mutation === refreshMutation
        )
          publish({
            ...snapshot,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (active === job) active = undefined;
      }
    });
    publish({
      status: "loading",
      ...(snapshot.data ? { data: snapshot.data } : {}),
    });
    return job.promise;
  }
  return {
    queries: Object.freeze({
      available,
      dismissSortError(group: string) {
        failedSorts.delete(group);
        publish(snapshot);
      },
      sortWritable: !!writeSort,
      setSort(
        group: string,
        mode: SidebarSortMode,
        sectionIds: readonly string[],
        signal?: AbortSignal,
      ) {
        if (closed || !writeSort || !snapshot.data)
          return Promise.reject(
            new Error("Sidebar sorting is read-only in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
        const id = ++nextSortMutation;
        pendingSorts.set(id, { group, mode });
        latestSort.set(group, id);
        failedSorts.delete(group);
        mutation++;
        const current = snapshot.data ?? {
          sections: [],
          assignments: {},
          starred: [],
          muted: [],
        };
        publish({
          status: "ready",
          data: retained({
            ...current,
            sort: withSort(current.sort ?? confirmedSort, group, mode),
          }),
        });
        const settle = (sort?: Readonly<Record<string, SidebarSortMode>>) => {
          if (closed || generation !== writeGeneration) return;
          if (sort) confirmedSort = { ...sort };
          pendingSorts.delete(id);
          const latest = snapshot.data ?? current;
          publish({
            status: "ready",
            data: retained({
              ...latest,
              sort: withPendingSorts(confirmedSort),
            }),
          });
        };
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar sorting is unavailable");
            try {
              writeSignal.throwIfAborted();
              const sort = await writeSort(
                group,
                mode,
                sectionIds,
                writeSignal,
              );
              if (closed || generation !== writeGeneration)
                throw new Error("Sidebar sorting is unavailable");
              writeSignal.throwIfAborted();
              mutation++;
              settle(sort);
              return sort;
            } catch (error) {
              if (!closed && generation === writeGeneration) {
                mutation++;
                if (!writeSignal.aborted && latestSort.get(group) === id)
                  failedSorts.set(group, {
                    group,
                    mode,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
              }
              settle();
              throw error;
            }
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      muteWritable: !!writeMute,
      setMute(channelId: string, muted: boolean, signal?: AbortSignal) {
        if (closed || !writeMute || !snapshot.data)
          return Promise.reject(
            new Error("Sidebar mutes are unavailable in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar mutes are unavailable");
            writeSignal.throwIfAborted();
            const mutes = await writeMute({ channelId, muted }, writeSignal);
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar mutes are unavailable");
            writeSignal.throwIfAborted();
            const current = snapshot.data;
            if (!current) throw new Error("Sidebar mutes are unavailable");
            mutation++;
            publish({
              status: "ready",
              data: Object.freeze({
                ...current,
                muted: Object.freeze([...mutes]),
              }),
            });
            return mutes;
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },

      // Keep explicit one-shot reads compatible; views use the retained snapshot.
      read,
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: () =>
        snapshot.status === "idle"
          ? refresh()
          : (active?.promise ?? Promise.resolve()),
      refresh,
    }),
    clear() {
      if (closed) return;
      generation++;
      mutation++;
      pendingSorts.clear();
      latestSort.clear();
      failedSorts.clear();
      confirmedSort = {};
      writeLifetime.abort();
      writeLifetime = new AbortController();
      active?.controller.abort();
      active = undefined;
      publish(empty());
    },
    dispose() {
      closed = true;
      generation++;
      mutation++;
      pendingSorts.clear();
      latestSort.clear();
      failedSorts.clear();
      confirmedSort = {};
      writeLifetime.abort();
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
