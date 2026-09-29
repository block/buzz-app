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
import type { PageNavigation } from "../navigation/service";
import type { ThreadSnapshot } from "../relay/threads";
import type { MessageComposerProps } from "./MessageComposer";
import type { MessageRowProps } from "./MessageRow";
import type {
  ConversationExtensions,
  ComposerAccessoryProps,
} from "../conversation/contracts";
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
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSend?.("new", [])}
      >
        Send fixture reply
      </button>
    </section>
  ),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
function setup(
  messageId = "root",
  extensions?: ConversationExtensions,
  navigation?: PageNavigation,
) {
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
  const library = createAgentLibrary(undefined).queries;
  let choices = library.snapshot();
  const session = {
    viewer: "viewer",
    thread: () => view,
    profiles: { ensure: async () => {} },
    agentChoices: {
      ...library,
      snapshot: () => choices,
      subscribe: view.subscribe,
    },
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
      extensions={extensions}
      session={session}
      scope="test"
      channelName="C"
      channelId="c"
      messageId={messageId}
      navigation={navigation}
      close={() => {}}
      onOpenLink={() => false}
    />,
  );
  return {
    setChoices(status: "ready" | "loading", keys: readonly string[]) {
      act(() => {
        choices = {
          ...choices,
          status,
          identities: keys.map((pubkey) => ({ pubkey, name: "Agent" })),
        };
        for (const fn of listeners) fn();
      });
    },
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
  expect(
    screen.queryByText("child", { selector: "article span" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child", { selector: "article span" })).toBeVisible();
  expect(screen.queryByText("grandchild")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(screen.getByText("grandchild")).toBeVisible();
  const rail = screen.getAllByRole("button", { name: "Hide replies" })[1];
  expect(rail).toBeDefined();
  if (!rail) throw new Error("Missing branch rail");
  fireEvent.click(rail);
  expect(
    screen.queryByText("child", { selector: "article span" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "View 2 replies" }),
    ).toHaveFocus(),
  );
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child", { selector: "article span" })).toBeVisible();
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
  expect(parent?.closest('[aria-label="Thread messages"]')).toBe(history);
  expect(
    parent?.closest('[aria-label="Agent coordination and activity"]'),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(screen.getByText("child", { selector: "article span" })).toBeVisible();
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
  expect(
    screen.queryByText("child", { selector: "article span" }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Composer")).toBeVisible();
});
it("an own ordinary reply stays visible without opening a nested branch", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("parent", "root"), row("child", "parent"), row("new", "root")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(screen.getByText("parent")).toBeVisible();
  expect(
    screen.queryByText("child", { selector: "article span" }),
  ).not.toBeInTheDocument();
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
    expect(
      screen
        .getByText("child", { selector: "article span" })
        .closest("article"),
    ).toHaveAttribute("data-layout", "continuation");
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
  expect(
    screen.queryByText("child", { selector: "article span" }),
  ).not.toBeInTheDocument();
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

it("keeps human-facing descendants visible through coordination ancestry and preserves reply targeting", () => {
  const h = setup();
  const coord = (id: string, parent: string) => ({
    ...row(id, parent),
    audience: "agents" as const,
    agentEnvelope: true as const,
  });
  h.update([coord("coord", "root"), coord("nested-coord", "coord")]);
  const trigger = screen.getByRole("button", {
    name: "Agent · Coordination",
  });
  expect(screen.queryByText("coord", { selector: "article span" })).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByText("coord", { selector: "article span" })).toBeVisible();
  fireEvent.click(trigger);
  const response = {
    ...row("human-facing", "nested-coord"),
    audience: "everyone" as const,
  };
  h.update([
    coord("coord", "root"),
    coord("nested-coord", "coord"),
    response,
    row("human", "root"),
  ]);
  for (const text of ["human-facing", "human"])
    expect(screen.getByText(text)).toBeVisible();
  for (const text of ["coord", "nested-coord"])
    expect(screen.queryByText(text, { selector: "article span" })).toBeNull();
  const groups = screen.getAllByRole("region", {
    name: "Agent coordination and activity",
  });
  expect(groups).toHaveLength(2);
  const firstGroup = groups[0];
  if (!firstGroup) throw new Error("Missing ancestor coordination group");
  fireEvent.click(
    within(firstGroup).getByRole("button", {
      name: "Agent · Coordination",
    }),
  );
  expect(screen.getByText("coord", { selector: "article span" })).toBeVisible();
  expect(
    screen.queryByText("nested-coord", { selector: "article span" }),
  ).toBeNull();
  expect(screen.getByText("human-facing")).toBeVisible();
  fireEvent.click(
    within(firstGroup).getByRole("button", {
      name: "Agent · Coordination",
    }),
  );
  expect(screen.queryByText("coord", { selector: "article span" })).toBeNull();
  expect(screen.getByText("human-facing")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Reply to human-facing" }),
  );
  expect(screen.getByLabelText("Composer")).toHaveAttribute(
    "data-parent",
    "human-facing",
  );
  expect(
    screen.getByRole("button", { name: "Send fixture reply" }),
  ).not.toBeDisabled();
});

it("does not combine coordination siblings across branches or a visible answer", () => {
  const h = setup();
  const coord = (id: string, parent: string) => ({
    ...row(id, parent),
    audience: "agents" as const,
    agentEnvelope: true as const,
  });
  h.update([
    coord("before", "root"),
    row("answer", "root"),
    coord("child", "answer"),
    coord("after", "root"),
  ]);
  expect(screen.getByText("answer")).toBeVisible();
  expect(
    screen.getAllByRole("region", { name: "Agent coordination and activity" }),
  ).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(
    screen.getAllByRole("region", { name: "Agent coordination and activity" }),
  ).toHaveLength(3);
  expect(screen.queryByText("child", { selector: "article span" })).toBeNull();
});

it("retains the selected reply target when late choices would group it", () => {
  const h = setup();
  const key = "a".repeat(64);
  h.update([{ ...row("coord", "root"), audience: "agents" }]);
  expect(screen.getByText("coord", { selector: "article span" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reply to coord" }));
  h.setChoices("ready", [key]);
  expect(screen.getByText("coord", { selector: "article span" })).toBeVisible();
  expect(screen.getByLabelText("Composer")).toHaveAttribute(
    "data-parent",
    "coord",
  );
  expect(
    screen.queryByRole("region", { name: "Agent coordination and activity" }),
  ).toBeNull();
});

it("gives a nested addressed request exactly one pending group under its own ancestry", () => {
  const h = setup();
  const key = "a".repeat(64);
  h.setChoices("ready", [key]);
  const nested = {
    ...row("request", "parent"),
    authorId: "viewer",
    mentions: [key],
  };
  h.update([row("parent", "root"), nested]);
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(
    screen.getAllByRole("region", { name: "Agent coordination and activity" }),
  ).toHaveLength(1);
  h.update([
    row("parent", "root"),
    nested,
    { ...row("coord", "request"), audience: "agents" },
  ]);
  const requestRow = screen.getByText("request").closest("li");
  if (!requestRow) throw new Error("Missing request row");
  fireEvent.click(
    within(requestRow).getByRole("button", { name: "View 1 reply" }),
  );
  expect(
    screen.getAllByRole("region", { name: "Agent coordination and activity" }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", {
      name: "Agent · Coordination",
    }),
  ).toHaveAttribute("aria-expanded", "false");
});

it("keeps a visible answer's byline when the preceding same-author coordination is collapsed", () => {
  const h = setup();
  h.update([
    { ...row("coord", "root"), audience: "agents", agentEnvelope: true },
    { ...row("answer", "root"), audience: "everyone" },
  ]);
  expect(screen.queryByText("coord", { selector: "article span" })).toBeNull();
  expect(screen.getByText("answer").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
});

it("keeps individual coordination collapsed and preserves request intent separately", () => {
  const keys = ["a".repeat(64), "b".repeat(64), "c".repeat(64)] as const;
  const empty = { snapshot: () => [], subscribe: () => () => {} };
  const entries = [
    {
      id: "activity",
      key: "test:activity",
      revision: "one",
      pluginId: "test",
      title: "Activity",
      placement: "conversation" as const,
      component: ({ request }: ComposerAccessoryProps) => (
        <section aria-label="Request details">
          {request?.agents.map((key) => (
            <p key={key}>Pending details {key}</p>
          ))}
        </section>
      ),
    },
  ];
  const extensions: ConversationExtensions = {
    tools: empty,
    inline: empty,
    accessories: { snapshot: () => entries, subscribe: () => () => {} },
  };
  const h = setup("root", extensions);
  h.update([]);
  h.setChoices("ready", keys);
  h.setRoot({ ...row("root"), authorId: "viewer", mentions: keys });
  expect(screen.getByRole("region", { name: "Request details" })).toBeVisible();
  const coord = (id: string, key: string) => ({
    ...row(id, "root"),
    authorId: key,
    threadRootId: "root",
    audience: "agents" as const,
  });
  const first = coord("coord-a", keys[0]);
  h.update([first]);
  const group = screen.getByRole("button", { name: "Agent · Coordination" });
  expect(group).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByText("coord-a", { selector: "article span" }),
  ).toBeNull();
  fireEvent.click(group);
  expect(
    screen.getByText("coord-a", { selector: "article span" }),
  ).toBeVisible();
  expect(screen.getByText(`Pending details ${keys[0]}`)).toBeVisible();
  expect(screen.getByText(`Pending details ${keys[1]}`)).toBeVisible();
  expect(screen.getByText(`Pending details ${keys[2]}`)).toBeVisible();
  const second = coord("coord-b", keys[1]);
  h.update([first, second]);
  expect(group).toHaveAttribute("aria-expanded", "true"); // Manual expansion survives traffic.
  expect(screen.getByText(`Pending details ${keys[1]}`)).toBeVisible();
  expect(screen.getByText(`Pending details ${keys[2]}`)).toBeVisible();
  expect(screen.getAllByText(/^Pending details /)).toHaveLength(3); // Coordination is not settlement.
  const third = coord("coord-c", keys[2]);
  h.update([first, second, third]);
  expect(screen.getByRole("region", { name: "Request details" })).toBeVisible();
  const answer = {
    ...row("Human-facing answer", "root"),
    authorId: keys[0],
    threadRootId: "root",
    audience: "everyone" as const,
  };
  h.update([first, second, third, answer]);
  fireEvent.click(group);
  expect(group).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("Human-facing answer")).toBeVisible();
  expect(
    screen.queryByText("coord-a", { selector: "article span" }),
  ).toBeNull();
  expect(
    screen.getAllByRole("region", { name: "Agent coordination and activity" }),
  ).toHaveLength(1);
  expect(screen.getByText("4 replies · 2 pending")).toBeVisible();
});

it("does not revive focus on a later manual coordination expansion", async () => {
  const h = setup("coord");
  const coord = {
    ...row("coord", "missing"),
    audience: "agents" as const,
    agentEnvelope: true as const,
  };
  const answer = row("answer", "coord");
  h.update([coord, answer]);
  const header = screen.getByRole("button", {
    name: "Agent · Coordination",
  });
  fireEvent.click(header);
  const target = screen
    .getByText("coord", { selector: "article span" })
    .closest("article");
  if (!target) throw new Error("Missing revealed coordination target");
  target.tabIndex = -1;
  target.focus();
  expect(target).toHaveFocus();
  // Late ordinary ancestry moves this body; opening the new transcript is explicit.
  h.update([coord, answer, row("missing", "root")]);
  expect(screen.getByText("answer")).toBeVisible();
  const nextHeader = screen.getByRole("button", {
    name: "Agent · Coordination",
  });
  expect(nextHeader).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("coord", { selector: "article span" })).toBeNull();
  // A manual later expansion must not revive captured focus intent.
  await act(async () => {});
  fireEvent.click(nextHeader);
  expect(
    screen.getByText("coord", { selector: "article span" }).closest("article"),
  ).not.toHaveFocus();
});

it("restores the exact coordination target after late reparenting, not its visible answer", async () => {
  const signal = new AbortController().signal;
  const navigation = {
    signal,
    target: { kind: "conversation", messageId: "coord" },
    complete: () => true,
  } as unknown as PageNavigation;
  const h = setup("coord", undefined, navigation);
  const coord = {
    ...row("coord", "missing"),
    audience: "agents" as const,
    agentEnvelope: true as const,
  };
  const answer = row("answer", "coord");
  h.update([coord, answer]);
  const target = screen
    .getByText("coord", { selector: "article span" })
    .closest("article");
  if (!target) throw new Error("Missing exact coordination target");
  target.tabIndex = -1;
  target.focus();
  h.update([coord, answer, row("missing", "root")]);
  await waitFor(() =>
    expect(
      screen
        .getByText("coord", { selector: "article span" })
        .closest("article"),
    ).toHaveFocus(),
  );
  expect(screen.getByText("answer")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Agent · Coordination" }));
  expect(screen.queryByText("coord", { selector: "article span" })).toBeNull();
  expect(screen.getByText("answer")).toBeVisible();
});

it("keeps each independently expanded coordination author's byline", () => {
  const h = setup();
  h.update(
    ["first", "second"].map((id) => ({
      ...row(id, "root"),
      audience: "agents" as const,
      agentEnvelope: true as const,
    })),
  );
  const second = screen.getAllByRole("button", {
    name: "Agent · Coordination",
  })[1];
  if (!second) throw new Error("Missing second coordination control");
  fireEvent.click(second);
  expect(screen.queryByText("first", { selector: "article span" })).toBeNull();
  expect(
    screen.getByText("second", { selector: "article span" }).closest("article"),
  ).toHaveAttribute("data-layout", "thread");
});
