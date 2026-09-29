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
import type { ChannelMessage, ChannelQueries } from "../relay/contracts";
import { createUnread } from "../relay/unread";
import { sidebarFixture } from "../relay/sidebar-testing";
import type { RelayEvent } from "../relay/events";
import { verifiedSymbol } from "nostr-tools";
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
function setup(messageId = "root", unread?: RelaySession["unread"]) {
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
    unread: unread ?? {
      subscribeMessages: () => () => {},
      snapshot: () => undefined,
      attention: () => ({ unread: false }),
    },
  } as unknown as RelaySession;
  const mounted = render(
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
    unmount: mounted.unmount,
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
it("keeps ordinary replies flat and visible when nested branches close or new replies arrive", () => {
  const h = setup();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("peer", "root"),
  ]);
  const history = screen.getByRole("region", { name: "Thread messages" });
  expect(
    within(history).queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
  const parent = screen.getByText("parent").closest("li");
  const peer = screen.getByText("peer").closest("li");
  expect(parent?.parentElement).toBe(peer?.parentElement);
  expect(parent?.parentElement?.parentElement).toBe(history);
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(screen.getByText("child")).toBeVisible();
  const collapse = screen.getAllByRole("button", { name: "Hide replies" })[0];
  if (!collapse) throw new Error("Missing nested collapse control");
  fireEvent.click(collapse);
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("peer", "root"),
    row("new", "root"),
  ]);
  for (const id of ["parent", "peer", "new"])
    expect(screen.getByText(id)).toBeVisible();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Composer")).toBeVisible();
});
it("an own ordinary reply stays visible without opening a nested branch", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("parent", "root"), row("child", "parent"), row("new", "root")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(screen.getByText("parent")).toBeVisible();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
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

it("preserves ordinary reply identity, focus and nested collapse state through root loss and return", () => {
  const h = setup();
  const parent = screen.getByText("parent").closest("article");
  const reply = screen.getByRole("button", { name: "Reply to parent" });
  reply.focus();
  h.setRoot(undefined);
  expect(screen.getByText("Original message unavailable.")).toBeVisible();
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  h.setRoot(row("root"));
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
});

for (const startsWithChild of [false, true])
  it(`preserves a reply subtree when it ${startsWithChild ? "loses its last" : "gains its first"} child`, () => {
    const h = setup("parent");
    const parent = row("parent", "root");
    const child = row("child", "parent");
    h.update(startsWithChild ? [parent, child] : [parent]);
    const message = screen.getByText("parent").closest("article");
    const reply = screen.getByRole("button", { name: "Reply to parent" });
    reply.focus();
    h.update(startsWithChild ? [parent] : [parent, child]);
    expect(screen.getByText("parent").closest("article")).toBe(message);
    expect(reply).toHaveFocus();
    expect(message).toBeInTheDocument();
    if (startsWithChild)
      expect(
        screen.queryByRole("button", { name: "View 1 reply" }),
      ).not.toBeInTheDocument();
    else
      expect(
        screen.getByRole("button", { name: "View 1 reply" }),
      ).toBeVisible();
  });

it("owns descendant evidence and rerenders on message changes without an aggregate count change", () => {
  const leases = new Map<string, () => void>();
  const unreadIds = new Set<string>();
  const aggregate = Object.freeze({});
  const unread = {
    snapshot: () => aggregate,
    subscribeMessages(
      _channelId: string,
      ids: readonly string[],
      listener: () => void,
    ) {
      for (const id of ids) leases.set(id, listener);
      return () => {
        for (const id of ids) leases.delete(id);
      };
    },
    attention(_channelId: string, id: string) {
      return { unread: leases.has(id) && unreadIds.has(id) };
    },
  } as unknown as RelaySession["unread"];
  const h = setup("root", unread);
  expect([...leases.keys()].sort()).toEqual(["child", "grandchild"]);
  expect(screen.getByRole("button", { name: "View 2 replies" })).toBeVisible();
  act(() => {
    unreadIds.add("grandchild");
    for (const listener of leases.values()) listener();
  });
  expect(
    screen.getByRole("button", {
      name: "View 2 replies. 1 new in available replies",
    }),
  ).toBeVisible();
  act(() => {
    unreadIds.clear();
    for (const listener of leases.values()) listener();
  });
  expect(screen.getByRole("button", { name: "View 2 replies" })).toBeVisible();
  h.update([row("parent", "root"), row("replacement", "parent")]);
  expect([...leases.keys()]).toEqual(["replacement"]);
  h.unmount();
  expect(leases.size).toBe(0);
});

it("bounds one grouped lease for more than 1000 nested replies and labels overflow unknown", async () => {
  const bff = sidebarFixture();
  const events = new Map<string, RelayEvent>();
  const messages = [
    row("root"),
    row("parent", "root"),
    ...Array.from({ length: 1101 }, (_, i) => row(`nested-${i}`, "parent")),
  ];
  for (const message of messages) {
    events.set(message.id, {
      id: message.id,
      pubkey: message.authorId,
      kind: 9,
      created_at: 1,
      tags: [
        ["h", "c"],
        ...(message.replyParentId ? [["e", "root", "", "root"]] : []),
      ],
      content: message.content,
      sig: "",
      [verifiedSymbol]: true,
    });
    bff.messages.set(message.id, {
      message_id: message.id,
      status: "unread",
      attention: false,
    });
  }
  const unread = createUnread({
    api: bff.api,
    storage: bff.storage,
    scope: "large-thread",
    viewer: "viewer",
    channels: {
      list: () => ({
        status: "ready",
        channels: [{ id: "c", members: ["viewer"] }],
      }),
      subscribeList: () => () => {},
    } as unknown as ChannelQueries,
    reader: { read: async () => [] },
    find: (id) => events.get(id),
  });
  const retain = vi.spyOn(unread.state, "retain");
  const h = setup("root", unread.capability);
  try {
    retain.mockClear();
    h.update(messages.slice(1));
    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0]?.[0].message_ids).toHaveLength(1101);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "View 1101 replies. At least 500 new in available replies",
        }),
      ).toBeVisible(),
    );
    expect(bff.api.contexts).toHaveBeenCalledTimes(5);
    expect(
      unread.capability.snapshot({
        kind: "message",
        channelId: "c",
        messageId: "nested-1100",
      }).unread,
    ).toEqual({ status: "unknown" });
    h.unmount();
    expect(
      unread.state.context({ channel_id: "c", root_id: "root" }),
    ).toBeUndefined();
  } finally {
    unread.dispose();
  }
});
