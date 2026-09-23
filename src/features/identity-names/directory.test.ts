import { expect, it, vi } from "vitest";
import type { AgentControlState, AgentView } from "../agents/control";
import { bindNames, type NameSource } from "./service";
import { npubEncode } from "nostr-tools/nip19";
import { agentDirectory, createAgentDirectory } from "./testing";

it("scopes native names to the session community and follows edits and disposal", () => {
  const key = "a".repeat(64);
  const listeners = new Set<() => void>();
  let state: AgentControlState = {
    status: "ready",
    busy: false,
    error: null,
    data: {
      runtimeAvailable: true,
      agents: [
        { pubkey: key, relayUrl: "wss://other.example", name: "Other" },
        { pubkey: key, relayUrl: "wss://here.example/", name: " Here " },
      ] as AgentView[],
    },
  };
  const provider = createAgentDirectory({
    snapshot: () => state,
    refresh: vi.fn(async () => {}),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const source: NameSource = {
    relayUrl: "https://here.example",
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => ({
        status: "ready",
        definitions: [],
        identities: [{ pubkey: key, name: "Legacy" }],
      }),
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const names = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  expect(names.resolve(key)).toBe("Here");
  const changed = vi.fn();
  names.subscribe(changed);
  const data = state.data;
  const agent = data?.agents[1];
  if (!data || !agent) throw new Error("Missing fixture agent");
  state = {
    ...state,
    data: {
      ...data,
      agents: [{ ...agent, name: "Edited" }],
    },
  };
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalledOnce();
  expect(names.resolve(key)).toBe("Edited");
  expect(provider.resolve({ ...source, relayUrl: undefined }, key)).toBe(
    "Legacy",
  );
  expect(
    provider.resolve({ ...source, relayUrl: "https://unrelated.example" }, key),
  ).toBe("Legacy");
  state = { ...state, status: "error" };
  expect(names.resolve(key)).toBe("Legacy");
  names.dispose();
  expect(listeners.size).toBe(0);
});

it("suffixes equal names across profiles, without merging keys or suffixing unique names", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64),
    d = "d".repeat(64),
    e = "e".repeat(64);
  const identities = [
    { pubkey: a, name: "Bad Janet", definitionId: "shared" },
    { pubkey: a.toUpperCase(), name: "Bad Janet", definitionId: "shared" },
    { pubkey: b, name: "Bad Janet", definitionId: "shared" },
    { pubkey: c, name: " Bad Janet ", definitionId: "other" },
    { pubkey: d, name: "Bad Janet" },
    { pubkey: e, name: "Larry", definitionId: "shared" },
  ];
  let library = { status: "ready", definitions: [], identities };
  const profiles = new Map();
  const source: NameSource = {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  for (const key of [a, b, c, d]) {
    expect(agentDirectory.resolve(source, key)).toBe(
      `Bad Janet · ${npubEncode(key).slice(-4)}`,
    );
  }
  expect(agentDirectory.resolve(source, e)).toBe("Larry");
  library = { ...library, identities: identities.slice(0, 2) };
  expect(agentDirectory.resolve(source, a)).toBe("Bad Janet");
  expect(agentDirectory.resolve(source, b)).toBeUndefined();
});

it("recomputes collisions for native edits, community scope, and profile fallbacks", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64);
  let agent = {
    pubkey: a,
    name: "Native Larry",
    relayUrl: "wss://here.test",
  } as AgentView;
  const listeners = new Set<() => void>();
  let native: AgentControlState = {
    status: "ready",
    busy: false,
    error: null,
    data: { runtimeAvailable: false, agents: [agent] },
  };
  const library = {
    status: "ready",
    definitions: [],
    identities: [
      { pubkey: a, name: "Legacy", definitionId: "linked" },
      { pubkey: b, name: "Legacy", definitionId: "linked" },
      { pubkey: c, name: "" },
    ],
  };
  let profiles = new Map([[c, { name: "Public Larry" }]]);
  const source: NameSource = {
    relayUrl: "https://here.test",
    profiles: {
      snapshot: () => profiles,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const provider = createAgentDirectory({
    snapshot: () => native,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async () => {},
  });
  const names = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  const changed = vi.fn();
  names.subscribe(changed);
  expect(names.resolve(a)).toBe("Native Larry");
  expect(names.resolve(b)).toBe("Legacy");
  expect(
    provider.resolve({ ...source, relayUrl: "https://other.test" }, a),
  ).toBe(`Legacy · ${npubEncode(a).slice(-4)}`);
  expect(agent.name).toBe("Native Larry");

  agent = { ...agent, name: "Legacy" };
  native = { ...native, data: { runtimeAvailable: false, agents: [agent] } };
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalledOnce();
  for (const key of [a, b])
    expect(names.resolve(key)).toBe(`Legacy · ${npubEncode(key).slice(-4)}`);

  profiles = new Map([[c, { name: "Legacy" }]]);
  for (const listener of listeners) listener();
  expect(names.resolve(c)).toBe(`Legacy · ${npubEncode(c).slice(-4)}`);
  profiles = new Map([[c, { name: "Public Larry" }]]);
  for (const listener of listeners) listener();
  expect(names.resolve(c)).toBe("Public Larry");
  names.dispose();
  expect(listeners.size).toBe(0);
});

it("includes native-only identities but ignores other-community and unready native records", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64);
  const library = {
    status: "ready",
    definitions: [],
    identities: [{ pubkey: a, name: "Larry" }],
  };
  let native: AgentControlState = {
    status: "ready",
    busy: false,
    error: null,
    data: {
      runtimeAvailable: false,
      agents: [
        { pubkey: b, name: "Larry", relayUrl: "wss://here.test" } as AgentView,
      ],
    },
  };
  const profiles = new Map();
  const source: NameSource = {
    relayUrl: "https://here.test",
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const provider = createAgentDirectory({
    snapshot: () => native,
    subscribe: () => () => {},
    refresh: async () => {},
  });
  for (const key of [a, b])
    expect(provider.resolve(source, key)).toBe(
      `Larry · ${npubEncode(key).slice(-4)}`,
    );
  expect(
    provider.resolve({ ...source, relayUrl: "https://elsewhere.test" }, a),
  ).toBe("Larry");
  expect(
    provider.resolve({ ...source, relayUrl: "https://elsewhere.test" }, b),
  ).toBeUndefined();
  native = { ...native, status: "error" };
  expect(provider.resolve(source, a)).toBe("Larry");
  expect(provider.resolve(source, b)).toBeUndefined();
});

it("applies viewer and owner metadata through the shared view and follows owner edits", () => {
  const me = "1".repeat(64),
    other = "2".repeat(64),
    a = "a".repeat(64),
    b = "b".repeat(64);
  const listeners = new Set<() => void>();
  let profiles = new Map([
    [me, { name: "Logan" }],
    [other, { name: "Wes" }],
    [a, { name: "Honey", isAgent: true as const, ownerPubkey: me }],
    [b, { name: "Honey", isAgent: true as const, ownerPubkey: other }],
  ]);
  const source: NameSource = {
    viewer: me,
    profiles: {
      snapshot: () => profiles,
      ensure: async () => {},
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    agentLibrary: {
      snapshot: () => ({ status: "ready", definitions: [], identities: [] }),
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const provider = createAgentDirectory();
  const names = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  expect(names.resolve(a)).toBe("Honey");
  expect(names.resolve(b)).toBe("Wes’s Honey");
  expect(provider.resolve({ ...source, viewer: other }, a)).toBe(
    "Logan’s Honey",
  );
  expect(names.resolve(a)).toBe("Honey");
  const changed = vi.fn();
  names.subscribe(changed);
  profiles = new Map([...profiles, [other, { name: "Wesley" }]]);
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalledOnce();
  expect(names.resolve(b)).toBe("Wesley’s Honey");
  names.dispose();
});
