import type { RelayData } from "./relayTypes";

// Test-only fixtures for the relay surface. The real RelaySession interface
// is large (host-defined, re-exported structurally via RelaySnapshot); tests
// only exercise a handful of members (agentLibrary, channels, messages,
// thread), so this stubs just those and casts through `unknown` rather than
// implementing the full interface.
// Controllable fixture for agentLibrary: starts however the test asks (idle
// by default, matching the real host's cold-start behavior) and only moves
// to "ready" once the test calls deliver(), notifying subscribers the same
// way a real async load would.
export function createFakeAgentLibrary(
  overrides: {
    identities?: { pubkey: string; name: string }[];
    status?: "idle" | "loading" | "ready" | "error" | "unavailable";
  } = {},
) {
  // useSyncExternalStore requires getSnapshot to return a stable reference
  // when nothing changed, or React re-renders forever; this object is only
  // replaced when state actually transitions.
  let snapshot: {
    definitions: never[];
    identities: { pubkey: string; name: string }[];
    status: "idle" | "loading" | "ready" | "error" | "unavailable";
    error: string | undefined;
  } = {
    definitions: [],
    identities: overrides.identities ?? [],
    status: overrides.status ?? "idle",
    error: undefined,
  };
  const listeners = new Set<() => void>();
  function notify() {
    for (const listener of listeners) listener();
  }
  const api = {
    snapshot: () => snapshot,
    refresh: async () => {
      snapshot = { ...snapshot, status: "loading" };
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    api,
    deliver(next: { pubkey: string; name: string }[]) {
      snapshot = {
        ...snapshot,
        identities: next,
        status: "ready",
        error: undefined,
      };
      notify();
    },
    fail(message: string) {
      snapshot = { ...snapshot, status: "error", error: message };
      notify();
    },
    getStatus: () => snapshot.status,
    subscriberCount: () => listeners.size,
  };
}

export function createFakeSession(
  overrides: {
    identities?: { pubkey: string; name: string }[];
    channels?: { id: string; name: string; members?: string[] }[];
    send?: (
      channelId: string,
      content: string,
      mentions?: readonly string[],
    ) => string;
    thread?: (channelId: string, messageId: string) => unknown;
    agentLibrary?: ReturnType<typeof createFakeAgentLibrary>["api"];
  } = {},
) {
  const identities = overrides.identities ?? [];
  const channels = overrides.channels ?? [];
  return {
    agentLibrary:
      overrides.agentLibrary ??
      createFakeAgentLibrary({ identities, status: "ready" }).api,
    channels: {
      list: () => ({ status: "ready" as const, channels }),
      subscribeList: () => () => {},
      window: () => {
        throw new Error("not implemented in fixture");
      },
      subscribeWindow: () => () => {},
      ensureList: () => {},
      ensure: () => {},
      loadOlder: () => {},
    },
    messages: {
      send:
        overrides.send ??
        (() => {
          throw new Error("messages.send not stubbed in this fixture");
        }),
      reply: () => {
        throw new Error("not implemented in fixture");
      },
      edit: () => {
        throw new Error("not implemented in fixture");
      },
      react: () => {
        throw new Error("not implemented in fixture");
      },
      retry: () => {},
    },
    thread:
      overrides.thread ??
      (() => {
        throw new Error("thread not stubbed in this fixture");
      }),
  } as unknown as ReturnType<RelayData["snapshot"]>["session"];
}

export function createFakeRelay(
  overrides: {
    generation?: number;
    session?: ReturnType<RelayData["snapshot"]>["session"];
  } = {},
): RelayData {
  const generation = overrides.generation ?? 0;
  const session = overrides.session ?? createFakeSession();
  const snapshot = {
    status: "ready" as const,
    generation,
    session,
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry: () => {},
    disconnect: () => {},
    clearCache: async () => {},
  } as unknown as RelayData;
}
