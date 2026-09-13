import type {
  SidebarAssignmentMutator,
  SidebarPreferences,
  SidebarSortMode,
  SidebarSortMutator,
} from "./sidebar-preferences";

type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  data?: SidebarPreferences;
  error?: string;
}>;

/** One bounded account-preference projection per relay session, not per page. */
export function createSidebarPreferencesStore(
  read: (signal?: AbortSignal) => Promise<SidebarPreferences>,
  available: boolean,
  write?: SidebarAssignmentMutator,
  writeSort?: SidebarSortMutator,
  notify = (listener: () => void) => listener(),
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
  let mutation = 0;
  let generation = 0;
  const retained = (data: SidebarPreferences): SidebarPreferences =>
    Object.freeze({
      sections: Object.freeze(
        data.sections.map((section) => Object.freeze({ ...section })),
      ),
      assignments: Object.freeze({ ...data.assignments }),
      starred: Object.freeze([...data.starred]),
      ...(data.sort ? { sort: Object.freeze({ ...data.sort }) } : {}),
    });
  const publish = (next: Snapshot) => {
    snapshot = Object.freeze(next);
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
        publish({ status: "ready", data: retained(data) });
      } catch (error) {
        if (!closed && !controller.signal.aborted && active === job)
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
      writable: !!write,
      sortWritable: !!writeSort,
      assign(channelId: string, sectionId?: string, signal?: AbortSignal) {
        if (closed || !write)
          return Promise.reject(
            new Error("Saved sidebar groups are read-only in this host"),
          );
        const writeGeneration = generation;
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Saved sidebar groups are unavailable");
            const groups = await write(
              { channelId, ...(sectionId ? { sectionId } : {}) },
              signal ?? new AbortController().signal,
            );
            if (closed || generation !== writeGeneration)
              throw new Error("Saved sidebar groups are unavailable");
            mutation++;
            const current = snapshot.data;
            publish({
              status: "ready",
              data: retained({
                sections: groups.sections,
                assignments: groups.assignments,
                starred: current?.starred ?? [],
                ...(current?.sort ? { sort: current.sort } : {}),
              }),
            });
            return groups;
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      async setSort(
        group: string,
        mode: SidebarSortMode,
        sectionIds: readonly string[],
        signal?: AbortSignal,
      ) {
        if (closed || !writeSort)
          throw new Error("Sidebar sorting is read-only in this host");
        const writeGeneration = generation;
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar sorting is unavailable");
            const sort = await writeSort(
              group,
              mode,
              sectionIds,
              signal ?? new AbortController().signal,
            );
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar sorting is unavailable");
            mutation++;
            const current = snapshot.data ?? {
              sections: [],
              assignments: {},
              starred: [],
            };
            publish({ status: "ready", data: retained({ ...current, sort }) });
            return sort;
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
      active?.controller.abort();
      active = undefined;
      publish(empty());
    },
    dispose() {
      closed = true;
      generation++;
      mutation++;
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
