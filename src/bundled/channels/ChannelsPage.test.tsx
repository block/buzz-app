import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Panels } from "../../features/panels/service";
import { ChannelsPage } from "./ChannelsPage";

// Inspect the actual element returned at the workspace boundary, not a parallel
// key helper. React uses this key to decide whether to retain the subtree.
vi.mock("../../features/relay/react", async (original) => ({
  ...(await original<typeof import("../../features/relay/react")>()),
  useRelayConnection: (relay: RelayData) => relay.snapshot(),
}));
function workspace(scope: string, generation: number) {
  const snapshot = { status: "ready", scope, generation } as RelaySnapshot;
  const relay = { snapshot: () => snapshot } as RelayData;
  const page = ChannelsPage({ relay, panels: {} as Panels });
  return page.props.children as ReactElement<{ scope: string }>;
}

it("distinguishes ready communities with the same connection generation", () => {
  const a = workspace("community-a:viewer", 1);
  const b = workspace("community-b:viewer", 1);
  expect(a.key).not.toBe(b.key);
  expect(a.props.scope).toBe("community-a:viewer");
  expect(b.props.scope).toBe("community-b:viewer");
});
it("distinguishes a replacement session within one scope without changing persisted intent keys", () => {
  const before = workspace("community-a:viewer", 1);
  const after = workspace("community-a:viewer", 2);
  expect(before.key).not.toBe(after.key);
  expect(before.props.scope).toBe(after.props.scope);
});
it("keeps the same workspace identity for updates within a session", () => {
  expect(workspace("community-a:viewer", 1).key).toBe(
    workspace("community-a:viewer", 1).key,
  );
});
