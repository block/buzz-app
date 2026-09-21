// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type {
  ThreadActivitySnapshot,
  UnreadSnapshot,
} from "../../features/relay/unread";
import { UnreadBadge } from "../channels/UnreadBadge";
import { SessionsWorkspace } from "./SessionsWorkspace";

afterEach(cleanup);

function unreadSession(observedCount: number | null) {
  const snapshot: UnreadSnapshot = {
    target: { kind: "channel", channelId: "session" },
    observedCount,
    attentionCount: observedCount === null ? null : 0,
    coverage: observedCount === null ? "unknown" : "observed",
    freshness: observedCount === null ? "unknown" : "observed",
    manual: "none",
  };
  const activity: ThreadActivitySnapshot = {
    channelId: "session",
    items: observedCount === null ? null : [],
    coverage: observedCount === null ? "unknown" : "observed",
    freshness: observedCount === null ? "unknown" : "observed",
  };
  return {
    unread: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      activity: () => activity,
      subscribeActivity: () => () => {},
    },
  } as unknown as RelaySession;
}

it("visibly marks ordinary unread state from the real unread badge", () => {
  const session = unreadSession(1);
  render(
    <SessionsWorkspace
      sessions={[
        {
          id: "session",
          title: "Plan the release",
          content: (
            <UnreadBadge
              session={session}
              channelId="session"
              label="Plan the release"
            />
          ),
        },
      ]}
      selected=""
      onSelect={vi.fn()}
      onNew={vi.fn()}
    >
      <div>Session content</div>
    </SessionsWorkspace>,
  );
  const row = screen.getByRole("button", { name: /Plan the release/ });
  expect(
    row.querySelector('[data-channel-unread-title="true"]'),
  ).toHaveTextContent("Plan the release");
  expect(row.querySelector("[data-channel-unread]")).toBeInTheDocument();
  expect(row.querySelector("[data-channel-priority]")).toBeNull();
});

it.each([0, null])(
  "keeps the session title quiet when the unread count is %s",
  (observedCount) => {
    const session = unreadSession(observedCount);
    render(
      <SessionsWorkspace
        sessions={[
          {
            id: "session",
            title: "Plan the release",
            content: (
              <UnreadBadge
                session={session}
                channelId="session"
                label="Plan the release"
              />
            ),
          },
        ]}
        selected=""
        onSelect={vi.fn()}
        onNew={vi.fn()}
      >
        <div>Session content</div>
      </SessionsWorkspace>,
    );
    const row = screen.getByRole("button", { name: /Plan the release/ });
    expect(row.querySelector("[data-channel-unread-title]")).toBeNull();
    expect(row.querySelector("[data-channel-unread]")).toBeNull();
  },
);
