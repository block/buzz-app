import type { HeadPersistence } from "./persistence";
import { isTransientFailure } from "./errors";
import { projectSidebarPreferences } from "./sidebar-preferences";
import type {
  SidebarAssignmentMutator,
  SidebarAssignmentIntent,
  SidebarSectionOrderMutator,
  SidebarGroups,
  SidebarSectionRemovalMutator,
  SidebarSectionRenameMutator,
  SidebarSectionCreationMutator,
  SidebarMuteMutator,
  SidebarPreferences,
} from "./sidebar-preferences";

type MoveDestination = Omit<SidebarAssignmentIntent, "channelId">;
type MoveIntent = Readonly<{
  id: number;
  channelId: string;
  destination: MoveDestination;
}>;
type MoveFailure = MoveIntent & Readonly<{ error: string }>;
type OrderFailure = Readonly<{
  sectionId: string;
  sectionIds: readonly string[];
  error: string;
}>;
type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  data?: SidebarPreferences;
  error?: string;
  /** Set with an error that a later retry can fix; see isTransientFailure. */
  transient?: true;
  cached?: true;
  moves?: readonly (MoveIntent & { pending: boolean; error?: string })[];
  orderError?: OrderFailure;
}>;

/** One bounded account-preference projection per relay session, not per page. */
export function createSidebarPreferencesStore({
  read,
  readAfterWrite = read,
  available,
  write,
  notify = (listener: () => void) => listener(),
  writeMute,
  persistence,
  removeSection,
  renameSection,
  groupsOnly = false,
  writeOrder,
  createSection,
}: Readonly<{
  read: (signal?: AbortSignal) => Promise<SidebarPreferences>;
  /** Fresh authoritative reconciliation after writes or live invalidation. */
  readAfterWrite?:
    | ((signal?: AbortSignal) => Promise<SidebarPreferences>)
    | undefined;
  available: boolean;
  write?: SidebarAssignmentMutator | undefined;
  notify?: ((listener: () => void) => void) | undefined;
  writeMute?: SidebarMuteMutator | undefined;
  persistence?: HeadPersistence | undefined;
  removeSection?: SidebarSectionRemovalMutator | undefined;
  renameSection?: SidebarSectionRenameMutator | undefined;
  /** Solo workspaces: removing a section is a plain groups write. */
  groupsOnly?: boolean | undefined;
  writeOrder?: SidebarSectionOrderMutator | undefined;
  createSection?: SidebarSectionCreationMutator | undefined;
}>) {
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
  let invalidation = 0;
  let reconciled = 0;
  let scheduled = false;
  const owed = () => invalidation !== reconciled;
  function scheduleReconciliation() {
    if (closed || !available || scheduled) return;
    scheduled = true;
    const scheduledGeneration = generation;
    queueMicrotask(() => {
      if (closed || generation !== scheduledGeneration) return;
      scheduled = false;
      if (owed()) void refresh(true);
    });
  }
  function invalidate() {
    if (closed || !available) return;
    invalidation++;
    scheduleReconciliation();
  }
  let confirmed: SidebarPreferences | undefined;
  let readFailure: string | undefined;
  let readTransient = false;
  // Retain writer routing through failed reads and cache clears until reconciled.
  let creationUncertain = false;
  const writable = () =>
    !closed && !!confirmed && readFailure === undefined && !!write;
  let nextMove = 0;
  const pendingMoves = new Map<number, MoveIntent>();
  const failedMoves = new Map<string, MoveFailure>();
  const latestMove = new Map<string, number>();
  let nextOrder = 0;
  let pendingOrder:
    | Readonly<{ id: number; sectionIds: readonly string[] }>
    | undefined;
  let failedOrder: OrderFailure | undefined;
  const orderWritable = () =>
    !closed &&
    !!confirmed &&
    readFailure === undefined &&
    !snapshot.cached &&
    !!writeOrder;
  const renameWritable = () =>
    !closed &&
    !!confirmed &&
    readFailure === undefined &&
    !snapshot.cached &&
    !!renameSection;
  const withPendingMoves = (data: SidebarPreferences): SidebarPreferences => {
    let sections = data.sections;
    const assignments = { ...data.assignments };
    for (const { channelId, destination } of pendingMoves.values()) {
      const created = destination.createSection;
      if (created && !sections.some(({ id }) => id === created.id)) {
        const section = {
          id: created.id,
          name: created.name.trim(),
          order:
            created.position === "first"
              ? Math.min(0, ...sections.map(({ order }) => order)) - 1
              : Math.max(-1, ...sections.map(({ order }) => order)) + 1,
        };
        sections =
          created.position === "first"
            ? [section, ...sections]
            : [...sections, section];
      }
      const target = created?.id ?? destination.sectionId;
      if (target) assignments[channelId] = target;
      else delete assignments[channelId];
    }
    if (pendingOrder) {
      const ids = pendingOrder.sectionIds;
      const rank = (id: string) =>
        ids.includes(id) ? ids.indexOf(id) : ids.length;
      sections = [...sections]
        .sort((a, b) => rank(a.id) - rank(b.id))
        .map((section, order) => ({ ...section, order }));
    }
    return { ...data, sections, assignments };
  };
  let generation = 0;
  const retained = (data: SidebarPreferences): SidebarPreferences =>
    Object.freeze({
      sections: Object.freeze(
        data.sections.map((section) => Object.freeze({ ...section })),
      ),
      assignments: Object.freeze({ ...data.assignments }),
      muted: Object.freeze([...data.muted]),
    });
  const publish = (next: Snapshot) => {
    const { moves: _moves, orderError: _order, ...state } = next;
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
      ...(moves.length ? { moves: Object.freeze(moves) } : {}),
      ...(failedOrder ? { orderError: failedOrder } : {}),
    });
    for (const listener of listeners) notify(listener);
  };
  // Both optimistic families overlay one confirmed snapshot. A completion only
  // replaces its own fields; mute stays confirmed-only for notification policy.
  const project = () => {
    if (!confirmed) return;
    void persistence
      ?.writeStartup?.({
        preferences: { savedAt: Date.now(), data: confirmed },
      })
      .catch(() => {});
    publish({
      // A field-only confirmation cannot recover a failed full read. Any
      // concurrent read made stale by a write must leave recovery available.
      ...(readFailure === undefined
        ? { status: "ready" as const }
        : {
            status: "error" as const,
            error: readFailure,
            ...(readTransient ? { transient: true as const } : {}),
          }),
      data: retained(withPendingMoves(confirmed)),
    });
  };
  function refresh(quiet = false): Promise<void> {
    if (closed || !available) return Promise.resolve();
    if (pendingMoves.size) {
      const refreshGeneration = generation;
      return writeQueue.then(() => {
        if (!closed && generation === refreshGeneration) return refresh(quiet);
      });
    }
    if (active) return active.promise;
    const controller = new AbortController();
    const job = { controller, promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(async () => {
      if (closed || controller.signal.aborted) return;
      const current = () =>
        !closed && !controller.signal.aborted && active === job;
      try {
        while (current()) {
          // Other preference families share the queue. Read after they settle,
          // and repeat if a write admitted during the read invalidates it.
          const authoritative = creationUncertain || owed();
          const writes = writeQueue;
          if (authoritative) await writes;
          if (!current()) return;
          // A newly admitted writer must settle before a strong read starts.
          if (authoritative && writes !== writeQueue) continue;
          const refreshMutation = mutation;
          const refreshInvalidation = invalidation;
          try {
            const data = await (authoritative ? readAfterWrite : read)(
              controller.signal,
            );
            if (!current()) return;
            if (
              mutation !== refreshMutation ||
              (authoritative && writes !== writeQueue)
            ) {
              if (creationUncertain || owed()) continue;
              return;
            }
            if (invalidation !== refreshInvalidation) continue;
            if (authoritative) reconciled = refreshInvalidation;
            readFailure = undefined;
            creationUncertain = false;
            confirmed = data;
            project();
            return;
          } catch (error) {
            if (!current()) return;
            if (
              mutation !== refreshMutation ||
              (authoritative && writes !== writeQueue)
            ) {
              if (creationUncertain || owed()) continue;
              return;
            }
            if (invalidation !== refreshInvalidation) continue;
            readFailure =
              error instanceof Error ? error.message : String(error);
            readTransient = isTransientFailure(error);
            const { transient: _transient, ...rest } = snapshot;
            publish({
              ...rest,
              status: "error",
              error: readFailure,
              ...(readTransient ? { transient: true as const } : {}),
            });
            return;
          }
        }
      } finally {
        if (active === job) active = undefined;
      }
    });
    // Live reconciliation is quiet while useful confirmed content is mounted.
    if (!quiet || !confirmed) {
      publish({
        status: "loading",
        ...(snapshot.cached ? { cached: true as const } : {}),
        ...(snapshot.data ? { data: snapshot.data } : {}),
      });
    }
    return job.promise;
  }
  function rejectMove(channelId: string, message: string): Promise<never> {
    const failed = failedMoves.get(channelId);
    if (failed) {
      failedMoves.set(channelId, { ...failed, error: message });
      publish(snapshot);
    }
    return Promise.reject(new Error(message));
  }
  // Optimistic placement is a projection over confirmed data. A failed older
  // intent cannot undo a later move or replace its retry state.
  function move(
    channelId: string,
    destination: MoveDestination,
    signal?: AbortSignal,
  ): Promise<SidebarPreferences> {
    if (
      !writable() ||
      (creationUncertain && "createSection" in destination) ||
      !snapshot.data ||
      !confirmed ||
      !write
    )
      return rejectMove(
        channelId,
        "Sidebar group moves are unavailable; refresh saved sidebar preferences before retrying",
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
          if (creationUncertain && "createSection" in destination)
            throw new Error("Section creation is unavailable");
          // Always check the fresh assignment head on removal, even if cached
          // placement has no assignment. Another device may have changed it.
          const groups = await write(
            { channelId, ...destination },
            writeSignal,
          );
          check();
          if (!confirmed)
            throw new Error("Sidebar group moves are unavailable");
          confirmed = {
            ...confirmed,
            sections: groups.sections,
            assignments: groups.assignments,
          };
          return retained(confirmed);
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
  async function removeSectionMutation(
    sectionId: string,
    signal?: AbortSignal,
  ) {
    if (
      closed ||
      !confirmed ||
      readFailure !== undefined ||
      snapshot.cached ||
      !removeSection
    )
      throw new Error("Sidebar section removal is unavailable");
    const writeGeneration = generation;
    const writeSignal = AbortSignal.any([
      writeLifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    writeSignal.throwIfAborted();
    mutation++;
    const run = writeQueue
      .catch(() => {})
      .then(async () => {
        if (closed || generation !== writeGeneration)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        if (!confirmed?.sections.some(({ id }) => id === sectionId))
          throw new Error("Sidebar section no longer exists");
        const next = await removeSection(sectionId, writeSignal);
        if (closed || generation !== writeGeneration || !confirmed)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        mutation++;
        confirmed = {
          ...confirmed,
          sections: next.sections,
          assignments: next.assignments,
        };
        project();
        return retained(confirmed);
      })
      .catch((error) => {
        if (!closed && generation === writeGeneration) {
          mutation++;
          project();
        }
        throw error;
      });
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const restoreGeneration = generation;
  const ready = persistence
    ?.readStartup?.()
    .then((saved) => {
      if (
        closed ||
        generation !== restoreGeneration ||
        confirmed ||
        snapshot.status === "ready"
      )
        return;
      const value = saved?.preferences;
      if (
        !value ||
        !Number.isFinite(value.savedAt) ||
        value.savedAt > Date.now() ||
        Date.now() - value.savedAt > 86_400_000
      )
        return;
      const data = value.data;
      const rows = (ids: readonly string[], flag: string) => ({
        version: 1,
        channels: Object.fromEntries(
          ids.map((id) => [id, { [flag]: true, updatedAt: 0 }]),
        ),
      });
      const parsed = projectSidebarPreferences(
        { version: 1, sections: data.sections, assignments: data.assignments },
        rows(data.muted, "muted"),
      );
      // Display-only: do not initialize the confirmed mutation base from disk.
      publish({
        ...snapshot,
        cached: true,
        data: retained(parsed),
      });
    })
    .catch(() => {});
  /** One queued groups-only write whose confirmed result replaces sections. */
  const writeGroups = (
    failure: string,
    run: (signal: AbortSignal) => Promise<SidebarGroups>,
  ) => {
    const writeGeneration = generation;
    const signal = writeLifetime.signal;
    const next = writeQueue
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        if (closed || generation !== writeGeneration) throw new Error(failure);
        const groups = await run(signal);
        signal.throwIfAborted();
        if (closed || generation !== writeGeneration || !confirmed)
          throw new Error(failure);
        mutation++;
        confirmed = { ...confirmed, ...groups };
        project();
      });
    writeQueue = next.catch(() => {});
    return next;
  };
  return {
    ready,
    invalidate,
    reconnect(continuous = false) {
      if (!continuous) invalidate();
      else if (owed()) scheduleReconciliation();
    },
    queries: Object.freeze({
      available,
      get sectionRemovalWritable() {
        return groupsOnly
          ? writable() && !snapshot.cached && !!removeSection
          : this.removeSectionWritable;
      },
      removeSection(sectionId: string, callerSignal?: AbortSignal) {
        if (!groupsOnly) return removeSectionMutation(sectionId, callerSignal);
        if (!writable() || snapshot.cached || !removeSection)
          return Promise.reject(new Error("Section deletion is unavailable"));
        return writeGroups("Section deletion is unavailable", (signal) =>
          removeSection(sectionId, signal),
        );
      },
      get sectionRenameWritable() {
        return renameWritable();
      },
      renameSection(sectionId: string, name: string) {
        if (!renameWritable() || !renameSection)
          return Promise.reject(new Error("Section rename is unavailable"));
        return writeGroups("Section rename is unavailable", (signal) =>
          renameSection({ sectionId, name }, signal),
        );
      },
      get sectionCreationWritable() {
        return (
          writable() &&
          !creationUncertain &&
          !snapshot.cached &&
          !!(createSection || write)
        );
      },
      createSection(section: Readonly<{ id: string; name: string }>) {
        const failure = groupsOnly
          ? "Workspaces are unavailable"
          : "Section creation is unavailable";
        const create =
          createSection ??
          (write
            ? (
                section: Readonly<{ id: string; name: string }>,
                signal: AbortSignal,
              ) => write({ createSection: section }, signal)
            : undefined);
        if (!writable() || creationUncertain || snapshot.cached || !create)
          return Promise.reject(new Error(failure));
        const writeGeneration = generation;
        return writeGroups(failure, (signal) => create(section, signal)).catch(
          async (error) => {
            if (!closed && generation === writeGeneration) {
              // The relay may have accepted the creation. Reconcile before
              // the form can discard its ID, without replaying the write or
              // joining a read that began before publication.
              active?.controller.abort();
              active = undefined;
              creationUncertain = true;
              await refresh();
            }
            throw error;
          },
        );
      },
      get sectionOrderWritable() {
        return orderWritable();
      },
      /** Optimistic whole-list order; the latest intent supersedes older ones. */
      reorderSections(sectionId: string, sectionIds: readonly string[]) {
        if (!orderWritable() || !writeOrder)
          return Promise.reject(
            new Error("Sidebar section order is unavailable"),
          );
        const save = writeOrder;
        const writeGeneration = generation;
        const signal = writeLifetime.signal;
        const intent = { id: ++nextOrder, sectionIds: [...sectionIds] };
        pendingOrder = intent;
        failedOrder = undefined;
        mutation++;
        project();
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            try {
              if (closed || generation !== writeGeneration)
                throw new Error("Sidebar section order is unavailable");
              signal.throwIfAborted();
              const groups = await save(intent.sectionIds, signal);
              if (closed || generation !== writeGeneration || !confirmed)
                throw new Error("Sidebar section order is unavailable");
              confirmed = {
                ...confirmed,
                sections: groups.sections,
                assignments: groups.assignments,
              };
              return retained(confirmed);
            } catch (error) {
              if (
                !closed &&
                generation === writeGeneration &&
                !signal.aborted &&
                pendingOrder === intent
              )
                failedOrder = {
                  sectionId,
                  sectionIds: intent.sectionIds,
                  error: error instanceof Error ? error.message : String(error),
                };
              throw error;
            } finally {
              if (!closed && generation === writeGeneration) {
                mutation++;
                if (pendingOrder === intent) pendingOrder = undefined;
                project();
              }
            }
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      dismissOrderError() {
        failedOrder = undefined;
        publish(snapshot);
      },
      get muteWritable() {
        return !!writeMute && !snapshot.cached;
      },
      setMute(channelId: string, muted: boolean, signal?: AbortSignal) {
        if (closed || !writeMute || !snapshot.data || snapshot.cached)
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
            const current = confirmed;
            if (!current) throw new Error("Sidebar mutes are unavailable");
            mutation++;
            confirmed = { ...current, muted: [...mutes] };
            project();
            return mutes;
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },

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
      get writable() {
        return writable();
      },
      assign(channelId: string, sectionId?: string, signal?: AbortSignal) {
        return move(channelId, sectionId ? { sectionId } : {}, signal);
      },
      createAndAssign(
        channelId: string,
        section: NonNullable<SidebarAssignmentIntent["createSection"]>,
        signal?: AbortSignal,
      ) {
        return move(channelId, { createSection: section }, signal);
      },
      get removeSectionWritable() {
        return (
          !closed &&
          !!confirmed &&
          readFailure === undefined &&
          !snapshot.cached &&
          !!removeSection
        );
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
      refresh: () => refresh(),
    }),
    clear() {
      if (closed) return;
      generation++;
      invalidation = reconciled = 0;
      scheduled = false;
      confirmed = undefined;
      readFailure = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
      pendingOrder = undefined;
      failedOrder = undefined;
      mutation++;
      writeLifetime.abort();
      writeLifetime = new AbortController();
      active?.controller.abort();
      active = undefined;
      publish(empty());
    },
    dispose() {
      closed = true;
      writeLifetime.abort();
      generation++;
      invalidation = reconciled = 0;
      scheduled = false;
      confirmed = undefined;
      readFailure = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
      pendingOrder = undefined;
      failedOrder = undefined;
      mutation++;
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
