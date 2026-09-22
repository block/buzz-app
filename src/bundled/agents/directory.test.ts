import { expect, it, vi } from "vitest";
import type {
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import {
  bindNames,
  type NameSource,
} from "../../features/identity-names/service";
import { createAgentDirectory } from "./directory";

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
