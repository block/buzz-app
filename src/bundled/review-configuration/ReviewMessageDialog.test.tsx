// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { ThreadSnapshot } from "../../features/relay/threads";
import { submissionRoute } from "./submission-route";
import { messageRoute, ReviewMessageDialog } from "./ReviewMessageDialog";

afterEach(cleanup);
it("validates message addresses without accepting content or malformed IDs", () => {
  expect(messageRoute({ channel: "channel", message: "a".repeat(64) })).toEqual(
    { channel: "channel", message: "a".repeat(64) },
  );
  for (const value of [
    null,
    [],
    "text",
    { channel: "", message: "a".repeat(64) },
    { channel: "channel", message: "not-a-message" },
  ])
    expect(messageRoute(value)).toBeUndefined();
});
it("loads the exact message, shows the whole body, and releases the read on close", async () => {
  const id = "a".repeat(64);
  let snapshot: ThreadSnapshot = {
    status: "loading",
    root: undefined,
    replies: [],
    canLoadMore: false,
    limited: false,
    error: undefined,
    targetStatus: "loading",
  };
  let notify = () => {};
  const dispose = vi.fn();
  const session = {
    thread: vi.fn(() => ({
      snapshot: () => snapshot,
      subscribe: (fn: () => void) => {
        notify = fn;
        return () => {};
      },
      refresh: async () => {},
      dispose,
    })),
  } as unknown as RelaySession;
  const view = render(
    <ReviewMessageDialog
      session={session}
      target={{ channel: "channel", message: id }}
      onClose={() => {}}
      finalFocus={() => null}
    />,
  );
  expect(session.thread).toHaveBeenCalledWith("channel", id, { exact: true });
  expect(screen.getByRole("status").textContent).toContain("Loading");
  const content = `Full review ${"details ".repeat(100)}END OF MESSAGE`;
  act(() => {
    snapshot = {
      ...snapshot,
      status: "ready",
      targetStatus: "ready",
      target: {
        id,
        channelId: "channel",
        authorId: "author",
        mentions: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
        participants: [],
        createdAt: 100,
        content,
      },
    };
    notify();
  });
  expect(screen.getByText(/END OF MESSAGE/).textContent).toBe(content);
  act(() => {
    snapshot = { ...snapshot, target: undefined, targetStatus: "unavailable" };
    notify();
  });
  expect(screen.queryByText(/END OF MESSAGE/)).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("unavailable");
  view.unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("restores only bounded submission identity from a detail address", () => {
  expect(
    submissionRoute({
      channel: "channel",
      submission: "submission",
      content: "ignored",
      message: "a".repeat(64),
    }),
  ).toEqual({ channel: "channel", submission: "submission" });
  for (const value of [
    null,
    [],
    "text",
    { channel: "", submission: "id" },
    { channel: "channel", submission: "../other" },
    { channel: "channel", submission: "a".repeat(129) },
  ])
    expect(submissionRoute(value)).toBeUndefined();
});
