import type {
  SidebarPreferences,
  SidebarMuteMutator,
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
  notify = (listener: () => void) => listener(),
  writeMute?: SidebarMuteMutator,
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
        publish({
          status: "ready",
          data: Object.freeze({
            sections: Object.freeze(
              data.sections.map((section) => Object.freeze({ ...section })),
            ),
            assignments: Object.freeze({ ...data.assignments }),
            starred: Object.freeze([...data.starred]),
            muted: Object.freeze([...data.muted]),
          }),
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
      writeLifetime.abort();
      writeLifetime = new AbortController();
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
