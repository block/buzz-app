// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentLibrary } from "../agents/library";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot } from "../relay/threads";
import type { MessageComposerProps } from "./MessageComposer";
import type { MessageRowProps } from "./MessageRow";
import { ThreadPanel } from "./ThreadPanel";

vi.mock("./use-reading", () => ({ useReading: () => {} }));
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useRowProfiles: () => profiles };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row, onReply, layout }: MessageRowProps) => (
    <article data-message-id={row.id} data-layout={layout}>
      <span>{row.content}</span>
      <button type="button" onClick={() => onReply?.(row.id)}>
        Reply to {row.content}
      </button>
    </article>
  ),
}));
vi.mock("./MessageComposer", () => ({
  MessageComposer: ({
    replyContext,
    replyParentId,
    onSend,
    disabled,
  }: MessageComposerProps) => (
    <section aria-label="Composer" data-parent={replyParentId}>
      {replyContext}
      <button type="button" disabled={disabled} onClick={() => onSend?.("new")}>
        Send fixture reply
      </button>
    </section>
  ),
}));
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
function row(id: string, replyParentId?: string): ChannelMessage {
  return {
    id,
    replyParentId,
    channelId: "c",
    authorId: "a".repeat(64),
    content: id,
    createdAt: 1,
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
}
function setup(messageId = "root") {
  let snapshot: ThreadSnapshot = {
    root: row("root"),
    replies: [
      row("parent", "root"),
      row("child", "parent"),
      row("grandchild", "child"),
    ],
    status: "ready",
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const listeners = new Set<() => void>();
  const view = {
    snapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh: async () => {},
    loadMore: async () => {},
    dispose: () => {},
  };
  const session = {
    thread: () => view,
    profiles: { ensure: async () => {} },
    agentChoices: createAgentLibrary(undefined).queries,
    messages: { retry: () => {} },
    media: () => undefined,
    unread: {
      subscribe: () => () => {},
      snapshot: () => undefined,
      attention: () => ({ unread: false }),
    },
  } as unknown as RelaySession;
  render(
    <ThreadPanel
      session={session}
      scope="test"
      channelName="C"
      channelId="c"
      messageId={messageId}
      close={() => {}}
      onOpenLink={() => false}
    />,
  );
  return {
    setRoot(root: ChannelMessage | undefined) {
      act(() => {
        snapshot = { ...snapshot, root };
        for (const fn of listeners) fn();
      });
    },
    update(replies: ChannelMessage[]) {
      act(() => {
        snapshot = { ...snapshot, replies };
        for (const fn of listeners) fn();
      });
    },
  };
}
it("expands immediate children, collapses all descendant state, and supports the rail shortcut", async () => {
  setup();
  expect(screen.getByText("parent")).toBeVisible();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child")).toBeVisible();
  expect(screen.queryByText("grandchild")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(screen.getByText("grandchild")).toBeVisible();
  const rail = screen.getAllByRole("button", { name: "Hide replies" })[1];
  expect(rail).toBeDefined();
  if (!rail) throw new Error("Missing branch rail");
  fireEvent.click(rail);
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "View 2 replies" }),
    ).toHaveFocus(),
  );
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child")).toBeVisible();
  expect(screen.queryByText("grandchild")).not.toBeInTheDocument();
});
it("targets a child, cancels on repeated Reply, resets after send and reveals the own branch", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  const composer = screen.getByLabelText("Composer");
  expect(composer).toHaveAttribute("data-parent", "parent");
  expect(
    within(composer).getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  expect(composer).not.toHaveAttribute("data-parent");
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("parent", "root"), row("new", "parent")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(composer).not.toHaveAttribute("data-parent");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});
it("reveals all available ancestors for a selected descendant, including late history", () => {
  const h = setup("grandchild");
  expect(screen.getByText("grandchild")).toBeVisible();
  h.update([row("grandchild", "missing")]);
  expect(
    screen.getByText("Earlier reply unavailable in loaded history."),
  ).toBeVisible();
  expect(screen.getByText("grandchild")).toBeVisible();
  h.update([row("grandchild", "missing"), row("missing", "root")]);
  expect(screen.getByText("grandchild")).toBeVisible();
  expect(
    screen.queryByText("Earlier reply unavailable in loaded history."),
  ).not.toBeInTheDocument();
});
it("does not silently retarget a deleted parent to the root", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  h.update([]);
  expect(
    screen.getByText("Reply target is no longer available."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Send fixture reply" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reply target" }));
  expect(
    screen.getByRole("button", { name: "Send fixture reply" }),
  ).toBeEnabled();
});

it("groups the first same-author reply with the root but respects the time window", () => {
  const h = setup();
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "continuation",
  );
  h.update([{ ...row("parent", "root"), createdAt: 602 }]);
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
  h.update([{ ...row("parent", "root"), authorId: "b".repeat(64) }]);
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
});
it("collapses only replies, restores focus, and reopens one level without losing the composer", async () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  const rail = screen.getAllByRole("button", {
    name: "Hide thread replies",
  })[1];
  if (!rail) throw new Error("Missing thread rail");
  fireEvent.click(rail);
  expect(screen.getByText("root")).toBeVisible();
  expect(screen.queryByText("parent")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Composer")).toBeVisible();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "View thread replies: 3" }),
    ).toHaveFocus(),
  );
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("peer", "root"),
  ]);
  expect(screen.queryByText("peer")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "View thread replies: 3" }),
  );
  expect(screen.getByText("parent")).toBeVisible();
  expect(screen.getByText("peer")).toBeVisible();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
});
it("an own root reply reopens a collapsed thread and reveals its row", () => {
  const h = setup();
  const toggle = screen.getAllByRole("button", {
    name: "Hide thread replies",
  })[0];
  if (!toggle) throw new Error("Missing thread toggle");
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("new", "root")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

it("does not offer collapse controls for an empty thread", () => {
  const h = setup();
  h.update([]);
  expect(screen.getByText("root")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^View thread replies:/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Composer")).toBeVisible();
});

it("keeps same-author continuation layout through pending, failed, and accepted delivery", () => {
  const h = setup("child");
  for (const delivery of ["sending", "failed", "accepted"] as const) {
    h.update([row("parent", "root"), { ...row("child", "parent"), delivery }]);
    expect(screen.getByText("child").closest("article")).toHaveAttribute(
      "data-layout",
      "continuation",
    );
  }
});

it("keeps replies available while a collapsed root is missing and restores its collapse preference", () => {
  const h = setup();
  const toggle = screen.getAllByRole("button", {
    name: "Hide thread replies",
  })[0];
  if (!toggle) throw new Error("Missing thread collapse control");
  fireEvent.click(toggle);
  expect(screen.queryByText("parent")).not.toBeInTheDocument();
  h.setRoot(undefined);
  expect(screen.getByText("Original message unavailable.")).toBeVisible();
  expect(screen.getByText("parent")).toBeVisible();
  h.setRoot(row("root"));
  expect(screen.queryByText("parent")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "View thread replies: 3" }),
  );
  expect(screen.getByText("parent")).toBeVisible();
});
