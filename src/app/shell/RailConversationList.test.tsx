// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import type { RailEntry } from "./rail-pins";
import { RailConversationItem } from "./RailConversationItem";
import { RailConversationList } from "./RailConversationList";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("moved exact destinations retain distinct targets and follow Mentions and live unread filters", async () => {
  const base = createRelaySession(null).session;
  const scope = {
    viewer: "c".repeat(64),
    communityOrigin: "https://example.org",
  };
  const roots = ["a".repeat(64), "b".repeat(64)];
  const entries: RailEntry[] = [
    ...roots.map(
      (root, index): RailEntry => ({
        id: `thread:${root}`,
        label: `Thread ${index + 1}`,
        kind: "channel",
        target: {
          version: 1,
          kind: "conversation",
          scope,
          channelId: "one",
          threadRootId: root,
          messageId: root,
          context: "channel",
        },
      }),
    ),
    {
      id: "mention",
      label: "Mention",
      kind: "channel",
      target: {
        version: 1,
        kind: "conversation",
        scope,
        channelId: "one",
        messageId: "d".repeat(64),
      },
    },
  ];
  const listeners = new Set<() => void>();
  const counts = new Map([
    [roots[0], 1],
    [roots[1], 0],
    ["d".repeat(64), 1],
    ["", 10],
  ]);
  const snapshots = new Map(
    [...counts].map(([id, observedCount]) => [
      id,
      {
        ...base.unread.snapshot({ kind: "channel", channelId: "one" }),
        observedCount,
      },
    ]),
  );
  const list = { status: "ready" as const, channels: [] };
  const session = {
    ...base,
    viewer: scope.viewer,
    channels: { ...base.channels, list: () => list },
    unread: {
      ...base.unread,
      ensure: async () => {},
      snapshot: (target: Parameters<typeof base.unread.snapshot>[0]) =>
        snapshots.get(
          target.kind === "thread"
            ? target.rootId
            : target.kind === "message"
              ? target.messageId
              : "",
        ) ?? base.unread.snapshot(target),
      subscribe: (_target: unknown, listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const open = vi.fn(async (_target: OpenTarget) => ({
    status: "opened" as const,
  }));
  render(
    <RailConversationList
      section="messages"
      entries={entries}
      session={session}
      scope={scope}
      navigator={{ open } as unknown as Navigation}
      target={{
        version: 1,
        kind: "page",
        pluginId: "example",
        pageId: "page",
        scope,
      }}
      renderOther={(entry) => {
        const destination = entry.target;
        return destination.kind === "person" ? null : (
          <RailConversationItem
            session={session}
            channel={{ id: "one", name: "One", channelType: "stream" }}
            destination={destination}
            avatar={null}
            place={entry.label}
            aria-label={entry.label}
            onClick={() => void open(destination)}
          />
        );
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Thread 1" })).toHaveAttribute(
    "aria-description",
    "Unread messages",
  );
  expect(screen.getByRole("button", { name: "Thread 2" })).not.toHaveAttribute(
    "aria-description",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Thread 1" }));
  await user.click(screen.getByRole("button", { name: "Thread 2" }));
  expect(open.mock.calls.map(([target]) => target)).toEqual([
    expect.objectContaining({
      channelId: "one",
      threadRootId: roots[0],
      messageId: roots[0],
      scope,
    }),
    expect.objectContaining({
      channelId: "one",
      threadRootId: roots[1],
      messageId: roots[1],
      scope,
    }),
  ]);
  await user.click(
    screen.getByRole("button", { name: "Filter and sort conversations" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", {
      name: "Unread only",
    }),
  );
  expect(screen.queryByRole("button", { name: "Thread 2" })).toBeNull();
  expect(screen.getByRole("button", { name: "Thread 1" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Mentions" }));
  expect(screen.getByRole("button", { name: "Mention" })).toBeVisible();
  act(() => {
    const key = "d".repeat(64);
    const prior = snapshots.get(key);
    if (!prior) throw new Error("Missing fixture snapshot");
    snapshots.set(key, { ...prior, observedCount: 0 });
    for (const listener of listeners) listener();
  });
  expect(screen.queryByRole("button", { name: "Mention" })).toBeNull();
});
