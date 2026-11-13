// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import type { RelayReader } from "../../features/relay/reader";
import { eventDto } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { keypair } from "../../features/relay/testing";
import { reviewAgentProfile, reviewTestAccess } from "./testing";
import { useReviewAgents } from "./use-review-agents";

afterEach(cleanup);
it("shows another member's agent when asynchronous ownership verification finishes", async () => {
  const viewer = keypair(),
    owner = keypair(),
    agent = keypair();
  const profiles = createProfileDirectory({
    read: async () => [],
  } as unknown as RelayReader);
  const choices = {
    identities: [],
    selectable: [],
    pending: false,
    archives: { status: "ready", archived: [] },
  };
  const session = {
    ...reviewTestAccess(viewer.pubkey, "channel", [owner.pubkey, agent.pubkey]),
    profiles: profiles.queries,
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure() {},
    },
  } as unknown as RelaySession;
  const hook = renderHook(() => useReviewAgents(session, "channel"));
  try {
    expect(hook.result.current.selectable).toEqual([]);
    act(() => profiles.accept([eventDto(reviewAgentProfile(owner, agent))]));
    await waitFor(() =>
      expect(hook.result.current.selectable.map((item) => item.pubkey)).toEqual(
        [agent.pubkey],
      ),
    );
    act(() => profiles.clear());
    expect(hook.result.current.selectable).toEqual([]);
  } finally {
    hook.unmount();
    profiles.dispose();
  }
});
