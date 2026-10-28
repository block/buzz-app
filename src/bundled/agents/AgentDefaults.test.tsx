// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents } from "../../features/agents/service";
import type { PageNavigation } from "../../features/navigation/service";
import { AgentDefaults } from "./AgentDefaults";

afterEach(cleanup);
it("fails an addressed Settings provider after its contribution is removed", async () => {
  const complete = vi.fn();
  const navigation = {
    target: {
      version: 1,
      kind: "settings",
      section: "agents",
      provider: "test/gone",
    },
    signal: new AbortController().signal,
    complete,
  } as unknown as PageNavigation;
  const types: never[] = [];
  const agents = {
    subscribe: () => () => {},
    types: () => types,
  } as unknown as Agents;
  render(
    <AgentDefaults
      agents={agents}
      navigation={navigation}
      onProvider={() => {}}
    />,
  );
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith({
      status: "failed",
      reason: "unavailable",
    }),
  );
});
