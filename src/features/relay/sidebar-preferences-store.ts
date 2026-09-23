import type {
  SidebarAssignmentMutator,
  SidebarAssignmentIntent,
  SidebarStarMutator,
  SidebarSortMode,
  SidebarSortMutator,
  SidebarPreferences,
} from "./sidebar-preferences";

type MoveDestination =
  | { starred: true }
  | Omit<SidebarAssignmentIntent, "channelId">;
type MoveIntent = Readonly<{
  id: number;
  channelId: string;
  destination: MoveDestination;
}>;
type MoveFailure = MoveIntent & Readonly<{ error: string }>;
type SortFailure = Readonly<{
  group: string;
  mode: SidebarSortMode;
  error: string;
}>;
type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  data?: SidebarPreferences;
  error?: string;
  moves?: readonly (MoveIntent & { pending: boolean; error?: string })[];
  sortErrors?: readonly SortFailure[];
}>;

/** One bounded account-preference projection per relay session, not per page. */
export function createSidebarPreferencesStore(
  read: (signal?: AbortSignal) => Promise<SidebarPreferences>,
  available: boolean,
  write?: SidebarAssignmentMutator,
  writeStar?: SidebarStarMutator,
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
  let writeLifetime = new AbortController();
  let mutation = 0;
  let confirmedPlacement: SidebarPreferences | undefined;
  let nextMove = 0;
  const pendingMoves = new Map<number, MoveIntent>();
  const failedMoves = new Map<string, MoveFailure>();
  const latestMove = new Map<string, number>();
  const withPendingMoves = (data: SidebarPreferences): SidebarPreferences => {
    let sections = data.sections;
    const assignments = { ...data.assignments };
    const starred = new Set(data.starred);
    for (const { channelId, destination } of pendingMoves.values()) {
      if ("starred" in destination) starred.add(channelId);
      else {
        starred.delete(channelId);
        const created = destination.createSection;
        if (created && !sections.some(({ id }) => id === created.id))
          sections = [
            ...sections,
            {
              ...created,
              name: created.name.trim(),
              order: Math.max(-1, ...sections.map(({ order }) => order)) + 1,
            },
          ];
        const target = created?.id ?? destination.sectionId;
        if (target) assignments[channelId] = target;
        else delete assignments[channelId];
      }
    }
    return { ...data, sections, assignments, starred: [...starred] };
  };
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
      ...(data.sort ? { sort: Object.freeze({ ...data.sort }) } : {}),
    });
  const publish = (next: Snapshot) => {
    const { moves: _moves, sortErrors: _sortErrors, ...state } = next;
    const moves = [
      ...Array.from(pendingMoves.values(), (intent) => ({
        ...intent,
        pending: true,
      })),
      ...Array.from(failedMoves.values(), (intent) => ({
        ...intent,
        pending: false,
      })),
    ];
    snapshot = Object.freeze({
      ...state,
      ...(failedSorts.size
        ? { sortErrors: Object.freeze([...failedSorts.values()]) }
        : {}),
      ...(moves.length ? { moves: Object.freeze(moves) } : {}),
    });
    for (const listener of listeners) notify(listener);
  };
  function refresh(): Promise<void> {
    if (closed || !available) return Promise.resolve();
    if (pendingMoves.size) return writeQueue;
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
        confirmedPlacement = data;
        publish({
          status: "ready",
          data: retained(
            withPendingMoves(
              pendingSorts.size
                ? { ...data, sort: withPendingSorts(confirmedSort) }
                : data,
            ),
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
  // Optimistic placement is a projection over confirmed data. Persistence keeps
  // assignment/create before Star removal, in the same queue as sorting. A failed
  // older intent cannot undo a later move or replace its retry state.
  function move(
    channelId: string,
    destination: MoveDestination,
    signal?: AbortSignal,
  ): Promise<SidebarPreferences> {
    if (closed || !snapshot.data || !confirmedPlacement || !writeStar || !write)
      return Promise.reject(
        new Error("Sidebar group moves are unavailable in this host"),
      );
    const writeGeneration = generation;
    const writeSignal = AbortSignal.any([
      writeLifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
    const intent: MoveIntent = { id: ++nextMove, channelId, destination };
    pendingMoves.set(intent.id, intent);
    latestMove.set(channelId, intent.id);
    failedMoves.delete(channelId);
    mutation++;
    const project = () => {
      if (!confirmedPlacement) return;
      const sort = snapshot.data?.sort;
      publish({
        status: "ready",
        data: retained(
          withPendingMoves({
            ...confirmedPlacement,
            ...(sort ? { sort } : {}),
          }),
        ),
      });
    };
    const check = () => {
      if (closed || generation !== writeGeneration)
        throw new Error("Sidebar group moves are unavailable");
      writeSignal.throwIfAborted();
    };
    const run = writeQueue
      .catch(() => {})
      .then(async () => {
        try {
          check();
          const starring = "starred" in destination;
          // Always check the fresh assignment head on removal, even if cached
          // placement has no assignment. Another device may have changed it.
          const groups = starring
            ? undefined
            : await write({ channelId, ...destination }, writeSignal);
          check();
          const stars = await writeStar(
            { channelId, starred: starring },
            writeSignal,
          );
          check();
          if (!confirmedPlacement)
            throw new Error("Sidebar group moves are unavailable");
          confirmedPlacement = {
            ...confirmedPlacement,
            ...(groups
              ? { sections: groups.sections, assignments: groups.assignments }
              : {}),
            starred: stars,
          };
          return retained(confirmedPlacement);
        } catch (error) {
          if (
            !closed &&
            generation === writeGeneration &&
            !writeSignal.aborted &&
            latestMove.get(channelId) === intent.id
          )
            failedMoves.set(channelId, {
              ...intent,
              error: error instanceof Error ? error.message : String(error),
            });
          throw error;
        } finally {
          if (!closed && generation === writeGeneration) {
            mutation++;
            pendingMoves.delete(intent.id);
            project();
          }
        }
      });
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    project();
    return run;
  }
  return {
    queries: Object.freeze({
      available,
      retryMove(channelId: string) {
        const failed = failedMoves.get(channelId);
        return failed
          ? move(channelId, failed.destination)
          : Promise.reject(new Error("No failed move to retry"));
      },
      dismissMoveError(channelId: string) {
        failedMoves.delete(channelId);
        publish(snapshot);
      },
      writable: !!write && !!writeStar,
      assign(channelId: string, sectionId?: string, signal?: AbortSignal) {
        return move(channelId, sectionId ? { sectionId } : {}, signal);
      },
      createAndAssign(
        channelId: string,
        section: { id: string; name: string },
        signal?: AbortSignal,
      ) {
        return move(channelId, { createSection: section }, signal);
      },
      starWritable: !!write && !!writeStar,
      async setStar(channelId: string, starred: boolean, signal?: AbortSignal) {
        const data = await move(
          channelId,
          starred ? { starred: true } : {},
          signal,
        );
        return data.starred;
      },
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
      confirmedPlacement = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
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
      pendingSorts.clear();
      latestSort.clear();
      failedSorts.clear();
      confirmedSort = {};
      writeLifetime.abort();
      generation++;
      confirmedPlacement = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
      mutation++;
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
