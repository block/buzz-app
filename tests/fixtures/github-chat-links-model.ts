import { createRelaySession } from "../../src/features/relay/session";
import type { ChannelSummary } from "../../src/features/relay/contracts";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import type { EventData } from "../../src/features/relay/events";
import { createSoloPulls } from "../../src/bundled/github/solo-pull";
import type { PullStates } from "../../src/bundled/github/pull-states";

/** Fictional relay boundary; the production link writer, store and UI stay real. */
export function chatLinksModel() {
  const owner = createRelaySession(null);
  const viewer = "a".repeat(64);
  const channel: ChannelSummary = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Update release notes",
    channelType: "solo",
    creator: viewer,
    members: [],
  } as unknown as ChannelSummary;
  let channels = {
    ...owner.session.channels.list(),
    status: "ready" as const,
    channels: [channel],
  };
  const channelListeners = new Set<() => void>();
  let head: EventData | undefined;
  const writes: EventData[] = [];
  let publishEffect = async () => {};
  const session = {
    ...owner.session,
    viewer,
    channels: {
      ...owner.session.channels,
      list: () => channels,
      get: (id: string) => channels.channels.find((item) => item.id === id),
      subscribeList: (listener: () => void) => {
        channelListeners.add(listener);
        return () => {
          channelListeners.delete(listener);
        };
      },
    },
    snapshotRead: async () => (head ? [head] : []),
    configArtifactWriter: {
      sign: async (template: Omit<EventData, "id" | "pubkey">) =>
        ({
          ...template,
          id: (writes.length + 1).toString(16).padStart(64, "0"),
          pubkey: viewer,
          sig: "",
        }) as EventData,
      publish: async (event: EventData) => {
        await publishEffect();
        head = event;
        writes.push(event);
      },
    },
  } as unknown as typeof owner.session;
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    session,
    scope: "example-scope",
    viewer,
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => connection,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as RelayData;
  const state = { state: "open" as const, checks: "success" as const };
  const states = {
    get: () => state,
    watch: () => () => {},
  } as unknown as PullStates;
  const pulls = createSoloPulls(session, states);
  return {
    session,
    viewer,
    relay,
    channel,
    pulls,
    states,
    writes,
    scope: "example-scope",
    pullsFor: () => pulls,
    setConnection(
      change: { [K in keyof RelaySnapshot]?: RelaySnapshot[K] | undefined },
    ) {
      connection = Object.fromEntries(
        Object.entries({ ...connection, ...change }).filter(
          ([, value]) => value !== undefined,
        ),
      ) as RelaySnapshot;
      for (const listener of listeners) listener();
    },
    setChannel(
      change: { [K in keyof ChannelSummary]?: ChannelSummary[K] | undefined },
    ) {
      channels = {
        ...channels,
        channels: [
          Object.fromEntries(
            Object.entries({ ...channels.channels[0], ...change }).filter(
              ([, value]) => value !== undefined,
            ),
          ) as ChannelSummary,
        ],
      };
      for (const listener of channelListeners) listener();
    },
    setPublish(effect: () => Promise<void>) {
      publishEffect = effect;
    },
    dispose: () => owner.dispose(),
  };
}
