import type {
  ChannelMessage,
  ChannelWindow,
  Profile,
  ChannelSummary,
} from "../relay/contracts";
import type { RelaySession } from "../relay/session";
export const row = (
  id: string,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage =>
  Object.freeze({
    id,
    channelId: "room",
    authorId: "a",
    createdAt: 100,
    content: id,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    ...patch,
  });
export function fixture(initial: readonly ChannelMessage[]) {
  const sources = new Map<string, Set<() => void>>();
  const subscribe = (kind: string) => (listener: () => void) => {
    const set = sources.get(kind) ?? new Set();
    sources.set(kind, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const emit = (kind: string) => {
    for (const fn of [...(sources.get(kind) ?? [])]) fn();
  };
  let window: ChannelWindow = Object.freeze({
    channelId: "room",
    rows: initial,
    status: "ready",
    hasMore: true,
    loadingOlder: false,
    error: undefined,
  });
  let profiles: ReadonlyMap<string, Profile> = new Map([
    ["a", { name: "Alice" }],
    ["b", { name: "Bob" }],
  ]);
  let channels: readonly ChannelSummary[] = [
    { id: "room", name: "Room", members: ["a", "b"] },
  ];
  let library = {
    definitions: [] as never[],
    identities: [] as { pubkey: string; name: string }[],
    status: "ready",
  };
  const session = {
    messages: {},
    channels: {
      window: () => window,
      subscribeWindow: (_id: string, listener: () => void) =>
        subscribe("window")(listener),
      list: () => ({ channels, status: "ready" }),
      subscribeList: subscribe("list"),
    },
    profiles: { snapshot: () => profiles, subscribe: subscribe("profiles") },
    agentChoices: { snapshot: () => library, subscribe: subscribe("choices") },
    agentLibrary: { snapshot: () => library, subscribe: subscribe("library") },
    names: {
      scope: () => (id: string) => {
        const profile = profiles.get(id);
        return profile ? { name: profile.name } : undefined;
      },
      subscribe: subscribe("names"),
    },
  } as unknown as RelaySession;
  return {
    session,
    sources,
    emit,
    window: () => window,
    publish(
      rows: readonly ChannelMessage[],
      metadata: Partial<ChannelWindow> = {},
    ) {
      window = Object.freeze({
        ...window,
        ...metadata,
        rows: Object.freeze([...rows]),
      });
      emit("window");
    },
    metadata(metadata: Partial<ChannelWindow>) {
      window = Object.freeze({ ...window, ...metadata });
      emit("window");
    },
    removeHistoryLimit() {
      const { historyLimited: _, ...next } = window;
      window = Object.freeze(next);
      emit("window");
    },
    library(identities: { pubkey: string; name: string }[]) {
      library = { ...library, identities };
      emit("library");
    },
    profile(id: string, profile: Profile) {
      profiles = new Map(profiles).set(id, Object.freeze(profile));
      emit("profiles");
      emit("names");
    },
    channel(
      patch:
        | Partial<ChannelSummary>
        | ((channel: ChannelSummary) => ChannelSummary),
    ) {
      channels = channels.map((channel) =>
        typeof patch === "function" ? patch(channel) : { ...channel, ...patch },
      );
      emit("list");
    },
  };
}
