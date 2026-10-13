import { expect, it } from "vitest";
import type { RegisteredAgentType } from "../../features/agents/service";
import {
  agentProviderRoute,
  agentProviderTarget,
  availableAgentProviderRoute,
} from "./routes";

const provider = {
  key: "test/echo",
  provider: {},
} as RegisteredAgentType;
const ordinary = { key: "test/plain" } as RegisteredAgentType;

it("admits only active provider routes and preserves the Agents page scope", () => {
  const route = { provider: "test/echo" };
  expect(agentProviderRoute(route)).toBe("test/echo");
  expect(availableAgentProviderRoute(route, [provider, ordinary])).toBe(true);
  expect(
    availableAgentProviderRoute({ provider: "test/plain" }, [ordinary]),
  ).toBe(false);
  expect(
    availableAgentProviderRoute({ provider: "test/gone" }, [provider]),
  ).toBe(false);
  for (const invalid of [
    null,
    "test/echo",
    { provider: "echo" },
    { provider: "test/echo", extra: true },
  ] as const)
    expect(agentProviderRoute(invalid)).toBeUndefined();

  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const opened = agentProviderTarget(base, "test/echo");
  expect(opened).toEqual({
    ...base,
    route: { version: 1, params: route },
  });
  expect(agentProviderTarget(opened)).toEqual(base);
});
