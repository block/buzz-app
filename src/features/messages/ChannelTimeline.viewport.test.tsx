// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";

const viewport = vi.hoisted(() => ({ size: 0 }));
// Control the independent virtualizer's public measurement/shift contract.
// React itself owns the real timeline's refs, render and effect ordering.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        shift,
      }: { children: import("react").ReactNode; shift: boolean },
      ref,
    ) {
      useImperativeHandle(
        ref,
        () => ({
          get viewportSize() {
            return viewport.size;
          },
          cache: [[], 40],
          scrollTo: vi.fn(),
          scrollToIndex: vi.fn(),
        }),
        [],
      );
      return (
        <ol aria-label="Virtualized messages" data-shift={shift}>
          {children}
        </ol>
      );
    }),
  };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row }: { row: ChannelMessage }) => <li>{row.content}</li>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function activityFixture() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const updates = (count: number): ChannelMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `activity-${index}`,
      channelId: "alpha",
      authorId: "agent",
      audience: "agents",
      createdAt: 100 + index,
      content: `Update ${index}`,
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    }));
  const content = (
    rows: ChannelMessage[],
    inlineTarget?: { messageId: string; signal: AbortSignal },
    chatPresentation = true,
  ) => (
    <ChannelTimeline
      channelId="alpha"
      scope="activity-folding"
      queries={owner.session}
      chatPresentation={chatPresentation}
      inlineTarget={inlineTarget}
      window={{
        channelId: "alpha",
        rows,
        status: "ready",
        hasMore: false,
        loadingOlder: false,
        freshness: "verified",
        error: undefined,
      }}
      onOpenLink={() => false}
    />
  );
  return { owner, updates, content };
}

it("keeps the last five updates, retains expanded history through appends, and folds back", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const view = render(content(updates(9)));
    expect(screen.queryByText("Update 3")).toBeNull();
    expect(screen.getByText("Update 4")).toBeVisible();
    const toggle = screen.getByRole("button", {
      name: "Show 4 previous steps",
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Update 0")).toBeVisible();
    view.rerender(content(updates(11)));
    expect(screen.getByRole("button", { name: "Show fewer" })).toBe(toggle);
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.getByText("Update 10")).toBeVisible();
    fireEvent.click(toggle);
    expect(screen.queryByText("Update 5")).toBeNull();
    expect(screen.getByText("Update 6")).toBeVisible();
    expect(toggle).toHaveTextContent("Show 6 previous steps");
    expect(toggle).toHaveFocus();
  } finally {
    owner.dispose();
  }
});

it("reveals an older folded message for an exact visit, then permits folding it again", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(9);
    const view = render(content(rows));
    expect(screen.queryByText("Update 0")).toBeNull();
    view.rerender(
      content(rows, {
        messageId: "activity-0",
        signal: new AbortController().signal,
      }),
    );
    expect(screen.getByText("Update 0")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByText("Update 0")).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("does not fold short runs, normal replies, or non-Solo timelines", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(9);
    const view = render(content(rows, undefined, false));
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.queryByRole("button", { name: /previous steps/ })).toBeNull();
    const middle = rows[4];
    if (!middle) throw new Error("Missing fixture reply");
    const { audience: _audience, ...publicReply } = middle;
    view.rerender(
      content([
        ...rows.slice(0, 4),
        { ...publicReply, content: "Main reply" },
        ...rows.slice(5),
      ]),
    );
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.getByText("Main reply")).toBeVisible();
    expect(screen.getByText("Update 5")).toBeVisible();
    expect(screen.queryByRole("button", { name: /previous steps/ })).toBeNull();
  } finally {
    owner.dispose();
  }
});

it.each([
  { anchor: "activity-8", expanded: false },
  { anchor: "activity-0", expanded: true },
])(
  "restores $anchor without unnecessarily expanding recent activity",
  ({ anchor, expanded }) => {
    const { owner, updates, content } = activityFixture();
    writeView("activity-folding", "scroll:alpha", {
      offset: 0,
      bottom: false,
      anchor: { id: anchor, y: 0 },
    });
    try {
      render(content(updates(9)));
      const toggle = screen.getByRole("button", {
        name: expanded ? "Show fewer" : "Show 4 previous steps",
      });
      expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
      if (expanded) expect(screen.getByText("Update 0")).toBeVisible();
      else expect(screen.queryByText("Update 0")).toBeNull();
    } finally {
      owner.dispose();
    }
  },
);

it("keeps membership notices visible in personal chats", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const row: ChannelMessage = {
    id: "joined",
    channelId: "alpha",
    authorId: viewer.pubkey,
    content: "",
    createdAt: 1,
    membership: {
      type: "member_joined",
      actor: viewer.pubkey,
      target: viewer.pubkey,
    },
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const window: ChannelWindow = {
    channelId: "alpha",
    rows: [row],
    status: "ready",
    hasMore: false,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
  };
  try {
    const view = render(
      <ChannelTimeline
        channelId="alpha"
        scope="membership"
        viewer={viewer.pubkey}
        queries={owner.session}
        window={window}
        chatPresentation
        onOpenLink={() => false}
      />,
    );
    expect(screen.getByText("You joined")).toBeVisible();
    view.rerender(
      <ChannelTimeline
        channelId="alpha"
        scope="membership"
        viewer={viewer.pubkey}
        queries={owner.session}
        window={{
          ...window,
          rows: [
            {
              ...row,
              id: "left",
              membership: {
                type: "member_left",
                actor: viewer.pubkey,
                target: viewer.pubkey,
              },
            },
          ],
        }}
        chatPresentation
        onOpenLink={() => false}
      />,
    );
    expect(screen.getByText("You left the channel")).toBeVisible();
    view.unmount();
  } finally {
    owner.dispose();
  }
});

it.each([0, 600])(
  "prepend compensation requires a measured virtualizer viewport (%s)",
  (size) => {
    viewport.size = size;
    // The outer timeline can have layout before Virtua's own observer delivers.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Leave positioning frames queued: this case controls the premeasurement boundary.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const viewer = keypair(),
      relay = keypair();
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    });
    const older = message(viewer, "alpha", "Older finite message", 1);
    const live = message(viewer, "alpha", "Live message", 2);
    const snapshot = (
      events: Parameters<typeof foldMessages>[2],
    ): ChannelWindow => ({
      channelId: "alpha",
      rows: foldMessages("alpha", relay.pubkey, events),
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      freshness: "verified",
      error: undefined,
    });
    const content = (window: ChannelWindow) => (
      <ChannelTimeline
        channelId="alpha"
        scope="viewport-regression"
        queries={owner.session}
        window={window}
        onOpenLink={() => false}
      />
    );
    try {
      const view = render(content(snapshot([live])));
      const boundary = screen.getByRole("list", {
        name: "Virtualized messages",
      });
      expect(boundary).toHaveAttribute("data-shift", "false");
      expect(screen.getByText("Live message")).toBeVisible();
      view.rerender(content(snapshot([older, live])));
      expect(screen.getByRole("list", { name: "Virtualized messages" })).toBe(
        boundary,
      );
      expect(boundary).toHaveAttribute("data-shift", size ? "true" : "false");
      expect(screen.getByText("Older finite message")).toBeVisible();
      view.unmount();
    } finally {
      owner.dispose();
    }
  },
);
