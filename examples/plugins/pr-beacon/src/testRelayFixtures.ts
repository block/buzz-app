import type { RelayData } from "./relayTypes";

// Test-only fixtures for the relay surface. The real RelaySession interface
// is large (host-defined, re-exported structurally via RelaySnapshot); tests
// only exercise a handful of members (agentLibrary, channels, messages,
// thread), so this stubs just those and casts through `unknown` rather than
// implementing the full interface.
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
  } = {},
) {
  const identities = overrides.identities ?? [];
  const channels = overrides.channels ?? [];
  return {
    agentLibrary: {
      snapshot: () => ({
        definitions: [],
        identities,
        status: "ready" as const,
      }),
      refresh: async () => {},
      subscribe: () => () => {},
    },
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
