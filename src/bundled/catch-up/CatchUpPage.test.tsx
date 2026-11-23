// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { UnreadSnapshot } from "../../features/relay/unread";
import type { Navigation } from "../../features/navigation/controller";
import { CatchUpView } from "./CatchUpPage";
import { apply } from "./index";

HTMLElement.prototype.setPointerCapture ??= () => {};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const scope = { viewer: "viewer", communityOrigin: "https://example.org" };
function setup(
  dm = false,
  emptyPreview = false,
  inboxBody = "Unread evidence preview",
  incomplete: string[] = [],
) {
  const listeners = new Set<() => void>();
  const state = new Map<string, UnreadSnapshot>(
    ["one", "two"].map((id) => [
      id,
      {
        target: { kind: "channel", channelId: id },
        observedCount: 2,
        attentionCount: 0,
        coverage: "observed",
        freshness: "observed",
        manual: "none",
      },
    ]),
  );
  const list = {
    status: "ready",
    channels: [
      {
        id: "one",
        name: dm ? "Direct message" : "First",
        ...(dm ? { channelType: "dm", participants: ["alice"] } : {}),
        preview: emptyPreview ? "" : "First preview",
        members: ["viewer"],
        lastActivityAt: 2,
      },
      {
        id: "two",
        name: "Second",
        preview: "Second preview",
        members: ["viewer"],
        lastActivityAt: 1,
      },
      { id: "archived", name: "Archived", members: ["viewer"], archived: true },
      { id: "other", name: "Not joined", members: ["other"] },
    ],
  };
  const markChannelRead = vi.fn(async (id: string) => {
    state.set(id, { ...(state.get(id) as UnreadSnapshot), observedCount: 0 });
    for (const listener of listeners) listener();
  });
  const reading = vi.fn();
  const sync = {
    status: "local",
    capability: "unsupported",
    completeness: "snapshot",
  };
  const inbox = {
    items: [
      {
        channelId: "one",
        preview: inboxBody,
        messageIds: ["preview-id"],
        previewMessageId: "preview-id",
      },
    ],
  };
  const profiles = new Map([["alice", { pubkey: "alice", name: "Alice" }]]);
  const feed = { incomplete };
  const session = {
    inboxFeed: { subscribe: () => () => {}, snapshot: () => feed },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    channels: {
      ensureList: vi.fn(),
      list: () => list,
      subscribeList: () => () => {},
      refreshList: vi.fn(),
    },
    unread: {
      inbox: () => inbox,
      subscribeInbox: () => () => {},
      sync: () => sync,
      subscribeSync: () => () => {},
      snapshot: ({ channelId }: { channelId: string }) =>
        state.get(channelId) ?? { observedCount: 0, manual: "none" },
      subscribe: (_: unknown, listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      markChannelRead,
      reading,
    },
  } as unknown as RelaySession;
  const open = vi.fn(async () => ({ status: "opened" }));
  const view = render(
    <CatchUpView
      session={session}
      scope={scope}
      navigator={{ open } as unknown as Navigation}
    />,
  );
  return { ...view, session, state, listeners, open, markChannelRead, reading };
}
async function ready() {
  await waitFor(() =>
    expect(document.querySelector('[aria-busy="true"]')).toBeNull(),
  );
}

it("previews without reading and keeps skipped conversations unread", async () => {
  const { markChannelRead, reading } = setup();
  await ready();
  expect(screen.getByText("First preview")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep unread" }));
  expect(screen.getByText("Second preview")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep unread" }));
  expect(screen.getByText("Review complete")).toBeTruthy();
  expect(markChannelRead).not.toHaveBeenCalled();
  expect(reading).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await ready();
  expect(screen.getByText("First preview")).toBeTruthy();
});

it("advances only after the read save completes and shared unread updates", async () => {
  const { markChannelRead, state, listeners } = setup();
  await ready();
  let finish!: () => void;
  markChannelRead.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
  expect(screen.getByText("First preview")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Keep unread" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    state.set("one", {
      ...(state.get("one") as UnreadSnapshot),
      observedCount: 0,
    });
    finish();
    for (const listener of listeners) listener();
  });
  expect(screen.getByText("Second preview")).toBeTruthy();
  expect(markChannelRead).toHaveBeenCalledExactlyOnceWith("one");
});

it("retains the card after a failed read and allows retry", async () => {
  const { markChannelRead } = setup();
  await ready();
  markChannelRead.mockRejectedValueOnce(new Error("Save failed"));
  fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Save failed")).toBeTruthy();
  expect(screen.getByText("First preview")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
  await screen.findByText("Second preview");
});

it("opens the current conversation through host navigation", async () => {
  const { open, markChannelRead } = setup();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
  expect(open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "one",
  });
  expect(markChannelRead).not.toHaveBeenCalled();
});

it("releases subscriptions when closed", async () => {
  const { listeners, unmount } = setup();
  await ready();
  expect(listeners.size).toBeGreaterThan(0);
  unmount();
  expect(listeners.size).toBe(0);
});

it("registers Catch up as a primary plugin page", () => {
  const register = vi.fn();
  apply({
    pages: { register },
    relay: {},
    navigation: {},
  } as unknown as Parameters<typeof apply>[0]);
  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "catch-up",
      title: "Catch up",
      primary: true,
    }),
  );
});

it("shows unread repair failures returned through snapshots, including with an empty queue", async () => {
  const { state, listeners } = setup();
  await ready();
  act(() => {
    for (const [id, value] of state)
      state.set(id, {
        ...value,
        observedCount: 0,
        error: "Unread repair failed",
      });
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Unread repair failed",
  );
  expect(screen.queryByText("No unread conversations observed")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("identifies unread DMs by their participants", async () => {
  setup(true);
  await ready();
  expect(
    screen.getByRole("article", { name: "Unread conversation: Alice" }),
  ).toBeTruthy();
  expect(screen.queryByText("Direct message")).toBeNull();
});

function drag(
  dx: number,
  dy = 0,
  type = "touch",
  cancel = false,
  target?: HTMLElement,
) {
  const card = screen.getByRole("article");
  const start = target ?? card;
  fireEvent.pointerDown(start, {
    pointerId: 1,
    pointerType: type,
    isPrimary: true,
    button: 0,
    clientX: 150,
    clientY: 100,
  });
  fireEvent.pointerMove(card, {
    pointerId: 1,
    clientX: 150 + dx,
    clientY: 100 + dy,
  });
  if (cancel) fireEvent.pointerCancel(card, { pointerId: 1 });
  else
    fireEvent.pointerUp(card, {
      pointerId: 1,
      clientX: 150 + dx,
      clientY: 100 + dy,
    });
}

it("swipes right to read and left to keep unread", async () => {
  const { markChannelRead } = setup();
  await ready();
  drag(-120);
  expect(screen.getByText("Second preview")).toBeTruthy();
  expect(markChannelRead).not.toHaveBeenCalled();
  drag(120);
  await screen.findByText("Review complete");
  expect(markChannelRead).toHaveBeenCalledExactlyOnceWith("two");
});

it("does not dismiss for short, vertical, cancelled gestures or mouse text selection", async () => {
  const { markChannelRead } = setup();
  await ready();
  drag(30);
  drag(120, 200);
  drag(120, 0, "touch", true);
  drag(120, 0, "mouse", false, screen.getByText("First preview"));
  expect(screen.getByText("First preview")).toBeTruthy();
  expect(markChannelRead).not.toHaveBeenCalled();
});

it("allows mouse dragging the header while buttons remain separate", async () => {
  const { markChannelRead } = setup();
  await ready();
  drag(
    120,
    0,
    "mouse",
    false,
    screen.getByRole("button", { name: "Keep unread" }),
  );
  expect(markChannelRead).not.toHaveBeenCalled();
  drag(-120, 0, "mouse", false, screen.getByText("First"));
  expect(screen.getByText("Second preview")).toBeTruthy();
});

it("binds trackpad momentum to one card and rearms after the gesture ends", async () => {
  const { markChannelRead } = setup();
  await ready();
  vi.useFakeTimers();
  const card = screen.getByRole("article");
  fireEvent.wheel(card, { deltaX: 60, deltaY: 0 });
  expect(card.style.transform).toBe("translateX(-60px)");
  fireEvent.wheel(card, { deltaX: 60, deltaY: 0 });
  expect(screen.getByText("Second preview")).toBeTruthy();
  fireEvent.wheel(card, { deltaX: 150, deltaY: 0 });
  expect(screen.getByText("Second preview")).toBeTruthy();
  expect(markChannelRead).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(220));
  fireEvent.wheel(card, { deltaX: -110, deltaY: 0 });
  await act(async () => {});
  expect(markChannelRead).toHaveBeenCalledExactlyOnceWith("two");
});

it("ignores vertical scrolling and control-wheel zoom", async () => {
  const { markChannelRead } = setup();
  await ready();
  const card = screen.getByRole("article");
  fireEvent.wheel(card, { deltaX: 10, deltaY: 150 });
  fireEvent.wheel(card, { deltaX: -150, deltaY: 0, ctrlKey: true });
  expect(screen.getByText("First preview")).toBeTruthy();
  expect(markChannelRead).not.toHaveBeenCalled();
});

it("blocks swipe actions while a save is pending and cancels timers on unmount", async () => {
  const { markChannelRead, unmount } = setup();
  await ready();
  vi.useFakeTimers();
  let finish!: () => void;
  markChannelRead.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  drag(120);
  drag(-120);
  fireEvent.wheel(screen.getByRole("article"), { deltaX: -200 });
  expect(screen.getByText("First preview")).toBeTruthy();
  expect(markChannelRead).toHaveBeenCalledTimes(1);
  unmount();
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => finish());
  expect(vi.getTimerCount()).toBe(0);
});

it("uses already observed unread previews before opening a channel", async () => {
  const { reading, markChannelRead } = setup(false, true);
  await ready();
  expect(screen.getByText("Unread evidence preview")).toBeTruthy();
  expect(reading).not.toHaveBeenCalled();
  expect(markChannelRead).not.toHaveBeenCalled();
});

it("withholds unsettled previews and hides spoilers in settled evidence", async () => {
  const first = setup(false, true, "The answer is ||Rosebud||", ["preview-id"]);
  await ready();
  expect(
    screen.getByText(
      "Preview updates are not ready. Open the conversation for context.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Rosebud/)).toBeNull();
  first.unmount();
  setup(false, true, "The answer is ||Rosebud||");
  await ready();
  expect(screen.getByText("The answer is [Spoiler]")).toBeTruthy();
  expect(screen.queryByText(/Rosebud/)).toBeNull();
});

it("never turns a vertical-start trackpad gesture into a card action", async () => {
  const { markChannelRead } = setup();
  await ready();
  vi.useFakeTimers();
  const card = screen.getByRole("article");
  fireEvent.wheel(card, { deltaX: 0, deltaY: 150 });
  fireEvent.wheel(card, { deltaX: -60, deltaY: 10 });
  fireEvent.wheel(card, { deltaX: -60, deltaY: 10 });
  expect(markChannelRead).not.toHaveBeenCalled();
  expect(screen.getByText("First preview")).toBeTruthy();
  act(() => vi.advanceTimersByTime(220));
  fireEvent.wheel(card, { deltaX: -120, deltaY: 0 });
  await act(async () => {});
  expect(markChannelRead).toHaveBeenCalledExactlyOnceWith("one");
});
