import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { AgentsPage } from "./AgentsPage";
vi.mock("../../features/relay/react", async (original) => ({
  ...(await original<typeof import("../../features/relay/react")>()),
  useRelayConnection: (relay: RelayData) => relay.snapshot(),
}));
function records(scope: string, generation: number) {
  const snapshot = { status: "ready", scope, generation } as RelaySnapshot;
  const page = AgentsPage({ relay: { snapshot: () => snapshot } as RelayData });
  return page.props.children[1] as ReactElement;
}
it("the actual records subtree distinguishes equal-generation communities and replacement sessions", () => {
  expect(records("A", 1).key).not.toBe(records("B", 1).key);
  expect(records("A", 1).key).not.toBe(records("A", 2).key);
  expect(records("A", 1).key).toBe(records("A", 1).key);
});
