import { expect, it, vi } from "vitest";
import type {
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import {
  bindNames,
  type NameSource,
} from "../../features/identity-names/service";
import { npubEncode } from "nostr-tools/nip19";
import {
  agentDirectory,
  identitySuffixes,
  createAgentDirectory,
} from "./directory";

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

it("extends whole collision groups deterministically, including case-normalized keys", () => {
  // These two different keys share the last six npub characters.
  const keys = [
    "3ee51d04715939ef0e492f7b87bf1dcaf2c0b4a16b753f19d7a92e96ba01b8db",
    "55e2be15c0fb4ba8231701c4ba65d545715b7c79761952fd8a7cc75cf6afb602",
    "4".repeat(64),
  ] as const;
  const rows = keys.map((pubkey) => ({
    pubkey,
    name: "Larry",
    definitionId: "shared",
  }));
  const labels = identitySuffixes(rows);
  expect([...labels.values()].map((value) => value.length)).toEqual([7, 7, 4]);
  expect(new Set(labels.values()).size).toBe(keys.length);
  for (const key of keys) {
    const suffix = labels.get(key);
    expect(suffix).toBeTruthy();
    expect(npubEncode(key).endsWith(suffix ?? "missing")).toBe(true);
  }
  expect(identitySuffixes([...rows].reverse())).toEqual(labels);
  expect(
    identitySuffixes([
      ...rows,
      {
        name: "Larry",
        pubkey: keys[0].toUpperCase(),
        definitionId: "shared",
      },
    ]),
  ).toEqual(labels);
});
it("suffixes only distinct keys sharing an explicit profile, even if its definition is missing", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64);
  const identities = [
    { pubkey: a, name: "Larry", definitionId: "shared" },
    { pubkey: a.toUpperCase(), name: "Larry", definitionId: "shared" },
    { pubkey: b, name: "Larry", definitionId: "other" },
    { pubkey: c, name: "Larry" },
  ];
  let library = { status: "ready", definitions: [], identities };
  const source: NameSource = {
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
    },
  };
  expect(identitySuffixes(identities).size).toBe(0);
  expect(agentDirectory.resolve(source, a)).toBe("Larry");
  library = {
    ...library,
    identities: [
      ...identities,
      { pubkey: "d".repeat(64), name: "Larry", definitionId: "shared" },
    ],
  };
  expect(agentDirectory.resolve(source, a)).toBe(
    `Larry ${npubEncode(a).slice(-4)}`,
  );
  expect(agentDirectory.resolve(source, "d".repeat(64))).toBe(
    `Larry ${npubEncode("d".repeat(64)).slice(-4)}`,
  );
  expect(agentDirectory.resolve(source, b)).toBe("Larry");
  expect(agentDirectory.resolve(source, c)).toBe("Larry");
  library = { ...library, identities };
  expect(agentDirectory.resolve(source, a)).toBe("Larry");
});

it("adds linked-profile suffixes to native names without changing native config", () => {
  const key = "a".repeat(64);
  const agent = {
    pubkey: key,
    name: "Native Larry",
    relayUrl: "wss://here.test",
  } as AgentView;
  const source: NameSource = {
    relayUrl: "https://here.test",
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => ({
        status: "ready",
        definitions: [],
        identities: [key, "b".repeat(64)].map((pubkey) => ({
          pubkey,
          name: "Legacy",
          definitionId: "linked",
        })),
      }),
      subscribe: () => () => {},
      refresh: async () => {},
    },
  };
  const provider = createAgentDirectory({
    snapshot: () => ({
      status: "ready",
      busy: false,
      error: null,
      data: { runtimeAvailable: false, agents: [agent] },
    }),
    subscribe: () => () => {},
    refresh: async () => {},
  });
  expect(provider.resolve(source, key)).toBe(
    `Native Larry ${npubEncode(key).slice(-4)}`,
  );
  expect(
    provider.resolve({ ...source, relayUrl: "https://other.test" }, key),
  ).toBe(`Legacy ${npubEncode(key).slice(-4)}`);
  expect(agent.name).toBe("Native Larry");
});
