import type { BuilderlabSession, Credential } from "../session";
import type { Connection, ConnectionsClient } from "./client";

export type ConnectionsState = Readonly<{
  /** The last list read under this sign-in; kept while a re-read runs or fails. */
  connections?: readonly Connection[];
  loading: boolean;
  error?: string;
}>;

const IDLE: ConnectionsState = Object.freeze({ loading: false });
const refused = (status: number) =>
  `Builderlab refused the request (HTTP ${status}).`;

/** One list read shared by Settings and expiry alerts, re-read on demand. */
export function createConnectionsStore(
  client: ConnectionsClient,
  session: BuilderlabSession,
) {
  let state = IDLE;
  let request: AbortController | undefined;
  const listeners = new Set<() => void>();
  const set = (next: ConnectionsState) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const reset = () => {
    request?.abort();
    request = undefined;
    if (state !== IDLE) set(IDLE);
  };
  async function refresh(): Promise<void> {
    if (session.snapshot().status !== "signed-in") return reset();
    request?.abort();
    const controller = new AbortController();
    request = controller;
    set({ ...state, loading: true });
    try {
      const result = await client.list(controller.signal);
      if (request !== controller) return;
      set(
        result.kind === "listed"
          ? { connections: result.connections, loading: false }
          : {
              ...state,
              loading: false,
              error:
                result.kind === "invalid_response"
                  ? "Builderlab sent a list this version of Buzz can’t read."
                  : refused(result.status),
            },
      );
    } catch (reason) {
      if (request !== controller || controller.signal.aborted) return;
      set({
        ...state,
        loading: false,
        error:
          reason instanceof Error
            ? reason.message
            : "Couldn’t load connections.",
      });
    } finally {
      if (request === controller) request = undefined;
    }
  }
  let credential: Credential | undefined;
  const follow = () => {
    const signedIn = session.snapshot().status === "signed-in";
    const next = signedIn ? session.credential() : undefined;
    if (next === credential) return;
    credential = next;
    reset();
    if (signedIn) void refresh();
  };
  const stopSession = session.subscribe(follow);
  follow();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    async disconnect(name: string) {
      const result = await client.disconnect(
        name,
        new AbortController().signal,
      );
      if (result.kind !== "accepted") throw new Error(refused(result.status));
      await refresh();
    },
    dispose() {
      stopSession();
      request?.abort();
      listeners.clear();
    },
  };
}
export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;
