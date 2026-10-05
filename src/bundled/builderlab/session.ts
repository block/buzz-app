import * as api from "./api";

type Snapshot = Readonly<{
  status: "idle" | "loading" | "signing-in" | "signing-out";
  account: api.Account | null;
  error?: string | undefined;
}>;

/** One plugin lifetime owns observation, never the persisted session. */
export function createSession() {
  let state: Snapshot = { status: "idle", account: null };
  let disposed = false;
  let attempt: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const run = async (
    status: Exclude<Snapshot["status"], "idle">,
    action: () => Promise<api.Account | null>,
  ) => {
    if (disposed || state.status !== "idle") return;
    publish({ ...state, status, error: undefined });
    try {
      const account = await action();
      publish({ status: "idle", account });
    } catch (error) {
      publish({
        status: "idle",
        account: state.account,
        error: attempt?.signal.aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : "Could not connect to Builderlab. Try again.",
      });
    } finally {
      attempt = undefined;
    }
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => run("loading", api.getAuth),
    signIn: () =>
      run("signing-in", () => {
        attempt = new AbortController();
        return api.login(attempt.signal);
      }),
    signOut: () =>
      run("signing-out", async () => {
        await api.signOut();
        if (disposed) return null;
        publish({ ...state, account: null });
        // bl may have rotated the item during logout; show the stored truth.
        return api.getAuth();
      }),
    cancel: () => attempt?.abort(),
    dispose() {
      disposed = true;
      attempt?.abort();
      listeners.clear();
    },
  };
}
export type Session = ReturnType<typeof createSession>;
