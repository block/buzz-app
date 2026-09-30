// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddedThread } from "./EmbeddedThread";
import type { Context } from "@deepseek-ai/cordis";
import type { ComponentProps } from "react";
import { createAgentLibrary } from "../agents/library";
import type { MessageComposerProps } from "../messages/MessageComposer";
import { useMessageDeletion } from "../messages/MessageManagement";
import type { MessageRowProps } from "../messages/MessageRow";
import type { PanelProps, RegisteredPanel } from "../panels/service";
import type { ChannelMessage } from "../relay/contracts";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";

// The real ThreadPanel and MessageManagement are composed; only leaf UI with
// its own mounted suites is reduced to the props this owner supplies.
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useRowProfiles: () => profiles };
});
vi.mock("../messages/MessageRow", () => ({
  MessageRow: ({ row, onOpenLink, onOpenMediaReview }: MessageRowProps) => (
    <article data-message-id={row.id}>
      <button type="button" onClick={() => onOpenLink?.("fixture:one")}>
        Open linked panel
      </button>
      <button
        type="button"
        // biome-ignore lint/style/noNonNullAssertion: the fixture row has one attachment.
        onClick={() => onOpenMediaReview?.(row.id, row.attachments[0]!, 0)}
      >
        Open media review
      </button>
    </article>
  ),
}));
vi.mock("../messages/MessageComposer", () => ({
  MessageComposer: ({ sessionConversation }: MessageComposerProps) => (
    <section
      aria-label="Composer"
      data-session-conversation={String(!!sessionConversation)}
      data-deletion={String(!!useMessageDeletion())}
    />
  ),
}));
vi.mock("../messages/MediaReviewViewer", () => ({
  MediaReviewViewer: (props: { onOpenLink(url: string): boolean }) => (
    <section aria-label="Media review">
      <button type="button" onClick={() => props.onOpenLink("fixture:one")}>
        Open panel from review
      </button>
    </section>
  ),
}));
vi.mock("../../shared/design-system/ui/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  channelType: "stream" | "session" = "stream",
  operations: readonly OutgoingEvent[] = [],
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let captured: PanelProps | undefined;
  const panel = {
    key: "fixture",
    id: "fixture",
    pluginId: "fixture",
    revision: "1",
    title: "Fixture",
    matches: () => true,
    component: (props: PanelProps) => {
      captured = props;
      return <p>Linked content</p>;
    },
  } as RegisteredPanel;
  let panels = [panel];
  const listeners = new Set<() => void>();
  const root: ChannelMessage = {
    id: "a".repeat(64),
    channelId: "c",
    authorId: "b".repeat(64),
    content: "root",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [{ url: "https://fixture.test/image.png", kind: "image" }],
    reactions: [],
    replyCount: 0,
  };
  const thread = {
    status: "ready",
    root,
    replies: [],
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const viewer = "a".repeat(64);
  const channels = {
    channels: [
      { id: "c", name: "Channel", channelType, members: [viewer] },
      { id: "d", name: "Other", channelType, members: [viewer] },
    ],
  };
  const unread = {
    sync: () => ({ capability: "unsupported" }),
    snapshot: () => undefined,
    subscribe: () => () => {},
    attention: () => ({ unread: false }),
    reading: vi.fn((_channelId: string) => ({
      view: vi.fn(),
      observe: vi.fn(async () => {}),
      dispose: vi.fn(),
    })),
  };
  const outbox = {
    subscribe: () => () => {},
    snapshot: () => operations,
    supports: () => true,
    retry: vi.fn(),
  };
  const session = {
    viewer,
    thread: () => ({
      snapshot: () => thread,
      subscribe: () => () => {},
      refresh: async () => {},
      loadMore: async () => {},
      dispose() {},
    }),
    channels: { subscribeList: () => () => {}, list: () => channels },
    profiles: { ensure: async () => {} },
    agentChoices: createAgentLibrary(undefined).queries,
    messages: { retry() {} },
    media: () => undefined,
    unread,
    outbox,
  } as unknown as RelaySession;
  const scope = `https://fixture.test:${viewer}`;
  const host = {
    panels: {
      snapshot: () => panels,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      resolve: () => panels[0],
    },
    relay: { snapshot: () => ({ status: "ready", session, scope }) },
    navigation: { open: vi.fn() },
  } as unknown as Context;
  const props = {
    host,
    session,
    scope,
    channelId: "c",
    channelName: "Channel",
    messageId: root.id,
    extensions: {} as ComponentProps<typeof EmbeddedThread>["extensions"],
  };
  return {
    props,
    unread,
    outbox,
    listeners,
    panelProps: () => captured,
    removePanels() {
      act(() => {
        panels = [];
        for (const fn of listeners) fn();
      });
    },
  };
}

it("retires panel actions on contribution removal, destination change and unmount", () => {
  const h = fixture();
  const view = render(<EmbeddedThread {...h.props} />);
  fireEvent.click(screen.getByText("Open linked panel"));
  expect(screen.getByText("Linked content")).toBeVisible();
  const old = h.panelProps();
  view.rerender(<EmbeddedThread {...h.props} messageId={"c".repeat(64)} />);
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
  expect(old?.context?.open("fixture:two")).toBe(false);
  fireEvent.click(screen.getByText("Open linked panel"));
  const removed = h.panelProps();
  h.removePanels();
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
  expect(removed?.context?.open("fixture:two")).toBe(false);
  view.unmount();
  expect(removed?.context?.open("fixture:two")).toBe(false);
  expect(h.listeners.size).toBe(0);
});

it("a panel opened from media review replaces the viewer, and media review replaces a panel", () => {
  render(<EmbeddedThread {...fixture().props} />);
  fireEvent.click(screen.getByText("Open media review"));
  fireEvent.click(screen.getByText("Open panel from review"));
  expect(screen.getByText("Linked content")).toBeVisible();
  expect(screen.queryByLabelText("Media review")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Open media review"));
  expect(screen.getByLabelText("Media review")).toBeVisible();
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
});

it.each([
  ["stream", "false"],
  ["session", "true"],
] as const)(
  "the %s-channel reply composer gets message management and session recipients=%s",
  (channelType, sessionConversation) => {
    render(<EmbeddedThread {...fixture(channelType).props} />);
    const composer = screen.getByLabelText("Composer");
    expect(composer).toHaveAttribute("data-deletion", "true");
    expect(composer).toHaveAttribute(
      "data-session-conversation",
      sessionConversation,
    );
  },
);

it("owns focused reading per thread and retires it on thread/channel retarget and unmount", () => {
  const h = fixture();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const view = render(<EmbeddedThread {...h.props} />);
  const focusReading = () =>
    act(() => {
      screen.getByRole("region", { name: "Thread messages" }).focus();
    });
  expect(h.unread.reading).not.toHaveBeenCalled(); // Mount is not reading.
  focusReading();
  expect(h.unread.reading).toHaveBeenCalledExactlyOnceWith("c");
  const first = h.unread.reading.mock.results[0]?.value;
  if (!first) throw new Error("Missing first reading lease");
  expect(first.view).toHaveBeenCalledWith(
    [h.props.messageId],
    expect.any(Function),
  );
  expect(first.view.mock.calls[0][1]()).toBe(true);

  view.rerender(<EmbeddedThread {...h.props} messageId={"c".repeat(64)} />);
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(first.view.mock.calls[0][1]()).toBe(false);
  expect(h.unread.reading).toHaveBeenCalledOnce();
  focusReading();
  expect(h.unread.reading).toHaveBeenCalledTimes(2);
  expect(h.unread.reading).toHaveBeenLastCalledWith("c");
  const second = h.unread.reading.mock.results[1]?.value;
  if (!second) throw new Error("Missing second reading lease");

  view.rerender(<EmbeddedThread {...h.props} channelId="d" />);
  expect(second.dispose).toHaveBeenCalledOnce();
  expect(second.view.mock.calls[0][1]()).toBe(false);
  focusReading();
  expect(h.unread.reading).toHaveBeenCalledTimes(3);
  expect(h.unread.reading).toHaveBeenLastCalledWith("d");
  const third = h.unread.reading.mock.results[2]?.value;
  if (!third) throw new Error("Missing third reading lease");
  view.unmount();
  expect(third.dispose).toHaveBeenCalledOnce();
  expect(third.view.mock.calls[0][1]()).toBe(false);
});

it("offers recovery for a failed edit left in the outbox", () => {
  const h = fixture("stream", [
    {
      event: {
        id: "edit",
        kind: 40003,
        content: "edited",
        tags: [
          ["h", "c"],
          ["e", "a".repeat(64)],
        ],
      },
      delivery: "failed",
      error: "Relay refused the edit.",
    } as unknown as OutgoingEvent,
  ]);
  render(<EmbeddedThread {...h.props} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Message edit: Relay refused the edit.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry message update" }));
  expect(h.outbox.retry).toHaveBeenCalledExactlyOnceWith("edit");
});
