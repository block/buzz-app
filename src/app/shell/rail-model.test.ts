// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { railModel } from "./rail-model";

vi.mock("../../features/conversation/conversation-index", () => {
  const solo = ["c:solo"];
  const team = ["c:dm", "c:general"];
  return {
    conversationIndex: () => ({
      watch: () => () => {},
      keys: (query: { home: string }) => (query.home === "team" ? team : solo),
    }),
  };
});
vi.mock("../../features/channel-navigation/solo-navigation", () => ({
  soloNavigationFor: () => undefined,
}));

const viewer = "a".repeat(64);
function harness() {
  const watching = new Set<() => void>();
  const source = () => ({
    subscribe: (listener: () => void) => {
      watching.add(listener);
      return () => watching.delete(listener);
    },
  });
  const profilesChanged = new Set<() => void>();
  const emit = () => {
    for (const listener of [...profilesChanged]) listener();
  };
  const state = {
    channels: [
      { id: "general", name: "General", channelType: "stream" },
      { id: "dm", name: "", channelType: "dm", participants: ["bob"] },
      { id: "solo", name: "Notes", channelType: "solo" },
    ],
    profiles: new Map<string, { name: string; picture?: string }>([
      ["bob", { name: "Bob" }],
    ]),
  };
  const choices = { selectable: [], identities: [], archives: {} };
  const session = {
    viewer,
    scope: `wss://relay.test:${viewer}`,
    channels: {
      ensureList: () => () => {},
      subscribeList: source().subscribe,
      list: () => ({ status: "ready", channels: state.channels }),
    },
    profiles: {
      subscribe: (listener: () => void) => {
        profilesChanged.add(listener);
        return () => profilesChanged.delete(listener);
      },
      snapshot: () => state.profiles,
    },
    archives: { ...source(), snapshot: () => undefined },
    agentChoices: {
      ...source(),
      snapshot: () => choices,
      retain: () => () => {},
      ensure: () => {},
    },
    names: { ...source(), resolve: () => undefined },
  } as unknown as RelaySession;
  return { session, state, emit, watching };
}

beforeEach(() => localStorage.clear());

test("watches the session only while something reads it, and builds once for every reader", () => {
  const { session, watching } = harness();
  const model = railModel(session);
  expect(watching.size).toBe(0);
  const first = model.subscribe(() => {});
  const second = model.subscribe(() => {});
  const active = watching.size;
  expect(active).toBeGreaterThan(0);
  expect(model.snapshot()).toBe(model.snapshot());
  expect(model.snapshot().entries.map((entry) => entry.label)).toEqual([
    "General",
    "Bob",
    "Notes",
  ]);
  expect(model.snapshot().soloChats.map((channel) => channel.id)).toEqual([
    "solo",
  ]);
  expect(model.snapshot().teamChats.map((channel) => channel.id)).toEqual([
    "dm",
    "general",
  ]);
  first();
  expect(watching.size).toBe(active);
  second();
  expect(watching.size).toBe(0);
});

test("a profile the rail does not name changes nothing, and one it names changes only its row", () => {
  const { session, state, emit } = harness();
  const model = railModel(session);
  const changed = vi.fn();
  const stop = model.subscribe(changed);
  const before = model.snapshot();

  state.profiles = new Map([...state.profiles, ["carol", { name: "Carol" }]]);
  emit();
  expect(model.snapshot()).toBe(before);

  state.profiles = new Map([...state.profiles, ["bob", { name: "Robert" }]]);
  emit();
  const after = model.snapshot();
  expect(after.byId.get("channel:dm")?.label).toBe("Robert");
  expect(after.byId.get("channel:general")).toBe(
    before.byId.get("channel:general"),
  );
  expect(after.channels).toBe(before.channels);
  stop();
});

test("the app's pages join the rows when the shell provides them", () => {
  const { session } = harness();
  const model = railModel(session);
  const changed = vi.fn();
  const stop = model.subscribe(changed);
  const pages = [
    { key: "example/page", title: "Example", pluginId: "example", id: "page" },
  ] as never;
  model.provide({ pages, sidebarSections: undefined });
  model.provide({ pages, sidebarSections: undefined });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(model.snapshot().byId.get("example/page")?.label).toBe("Example");
  stop();
});
