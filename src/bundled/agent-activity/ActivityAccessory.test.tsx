// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

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
    presence: {
      subscribe: () => () => {},
      status: () => "online",
      limited: () => false,
    },
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
    message: {
      id: root,
      channelId: "c",
      authorId: viewer,
      createdAt: 1,
      content: "Request",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    },
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

it("shows one bubble with one avatar per agent across multiple turns, removing only the settled agent", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a1", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a2", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b1", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getAllByRole("button", { name: /View agent activity/ }),
    ).toHaveLength(1);
    expect(screen.getAllByTitle("Blossom")).toHaveLength(1);
    expect(screen.getAllByTitle("Bubbles")).toHaveLength(1);
    expect(view.container.querySelector(".buzz-avatar-status-dot")).toBeNull();
    f.send(A, "a1", 2, "turn_completed");
    expect(
      screen.getByRole("button", { name: /View agent activity: Blossom/ }),
    ).toBeInTheDocument();
    f.send(A, "a2", 2, "turn_completed");
    expect(
      screen.queryByRole("button", { name: /Blossom/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /View agent activity: Bubbles/ }),
    ).toBeInTheDocument();
    f.send(B, "b1", 2, "turn_completed");
    expect(
      screen.queryByLabelText("Agent activity on this message"),
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
      screen.getByRole("button", { name: /View agent activity: Bubbles/ }),
    ).toHaveTextContent("Status unknown");
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
    const avatars = screen.getAllByTitle(/Blossom/);
    expect(avatars).toHaveLength(2);
    expect(avatars[0]?.getAttribute("title")).not.toBe(
      avatars[1]?.getAttribute("title"),
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("previews only live scoped actions and retains profile navigation", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "old", 1, "turn_started", { triggeringEventIds: [root] });
    const thought = (text: string) => ({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        },
      },
    });
    f.send(A, "old", 2, "acp_read", thought("Old thought"));
    f.send(A, "old", 3, "turn_completed");
    f.send(A, "new", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(
      screen.getByText("Waiting for activity details"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Old thought")).not.toBeInTheDocument();
    f.send(A, "new", 2, "acp_read", thought("Current thought"));
    expect(screen.getByText("Current thought")).toBeInTheDocument();
    f.send(B, "sibling", 1, "turn_started", { triggeringEventIds: [next] });
    f.send(B, "sibling", 2, "acp_read", thought("Private sibling thought"));
    expect(
      screen.queryByText("Private sibling thought"),
    ).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.getByText("Activity interrupted or out of date"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Current thought")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    expect(f.props.open).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("removes the whole popup when access is revoked", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<ActivityAccessory {...f.props} canOpen={() => false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
