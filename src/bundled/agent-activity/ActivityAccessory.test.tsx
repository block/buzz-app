// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen } from "@testing-library/react";

import { afterEach, expect, it, vi } from "vitest";
import { ActivityAccessory } from "./ActivityAccessory";
import { createAgentActivity } from "../../features/agents/activity";
import { createAgentLibrary } from "../../features/agents/library";
import type { RelaySession } from "../../features/relay/session";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const A = "b".repeat(64),
  B = "c".repeat(64),
  viewer = "a".repeat(64),
  root = "1".repeat(64),
  next = "2".repeat(64);
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  const live = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(live);
  const profiles = new Map([
    [A, { name: "Blossom", isAgent: true }],
    [B, { name: "Bubbles", isAgent: true }],
  ]);
  const session = {
    viewer,
    agentActivity: activity.queries,
    agentChoices: createAgentLibrary(undefined).queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    live: { retry: () => activity.state(live) },
    media: () => undefined,
  } as unknown as RelaySession;
  const send = (
    agent: string,
    turnId: string,
    seq: number,
    kind: string,
    payload: unknown = {},
  ) =>
    act(() => {
      activity.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            turnId,
            channelId: "c",
            sessionId: "S",
            seq,
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      );
    });
  const open = vi.fn(() => true);
  const props = {
    session,
    scope: "test",
    channelId: "c",
    threadRootId: root,
    canOpen: () => true,
    open,
  };
  return {
    activity,
    release,
    send,
    props,
    live,
    profiles,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}

it("shows one line per agent across multiple turns, removing only the settled agent", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a1", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a2", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b1", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getAllByRole("button", { name: /View activity for Blossom/ }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: /View activity for Bubbles/ }),
    ).toHaveLength(1);
    f.send(A, "a1", 2, "turn_completed");
    expect(
      screen.getByRole("button", { name: /View activity for Blossom/ }),
    ).toBeInTheDocument();
    f.send(A, "a2", 2, "turn_completed");
    expect(
      screen.queryByRole("button", { name: /Blossom/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /View activity for Bubbles/ }),
    ).toBeInTheDocument();
    f.send(B, "b1", 2, "turn_completed");
    expect(
      screen.queryByLabelText("Agent activity in this thread"),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("does not show sibling thread work and reports lost freshness without pretending completion", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "other", 1, "turn_started", { triggeringEventIds: [next] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    f.send(B, "here", 1, "turn_started", { triggeringEventIds: [root] });
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.getByRole("button", { name: /View activity for Bubbles/ }),
    ).toHaveTextContent("work status unknown");
    f.send(B, "here", 2, "turn_completed");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("keeps namesakes as separate exact identities", () => {
  const f = fixture();
  f.profiles.set(B, { name: "Blossom", isAgent: true });
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b", 1, "turn_started", { triggeringEventIds: [root] });
    const buttons = screen.getAllByRole("button", { name: /Blossom/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).not.toBe(buttons[1]?.textContent);
  } finally {
    view.unmount();
    f.dispose();
  }
});
