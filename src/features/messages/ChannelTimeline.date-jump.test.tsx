// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { readView } from "../../shared/view-state";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import { createRelaySession } from "../relay/session";
import { keypair } from "../relay/testing";
import { ChannelTimeline } from "./ChannelTimeline";
import { jumpStart } from "./date-jump";
import { DayDivider } from "./MessageTimestamp";
import styles from "./Messages.module.css";

const reading = vi.hoisted(() => ({ enabled: [] as (boolean | undefined)[] }));
const list = vi.hoisted(() => ({
  scrollToIndex: undefined as undefined | ((...args: unknown[]) => void),
}));
vi.mock("./use-reading", () => ({
  useReading: ({ enabled }: { enabled?: boolean }) => {
    reading.enabled.push(enabled);
  },
  readingPositioned: vi.fn(),
}));
// Virtua's measurement is not under test; render every row.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: import("react").ReactNode },
      ref,
    ) {
      useImperativeHandle(
        ref,
        () => ({
          viewportSize: 600,
          scrollOffset: 0,
          cache: [[], 40],
          findItemIndex: () => 0,
          getItemOffset: () => 0,
          scrollTo: vi.fn(),
          scrollToIndex: (...args: unknown[]) => list.scrollToIndex?.(...args),
        }),
        [],
      );
      return <ol>{children}</ol>;
    }),
  };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row, day }: { row: ChannelMessage; day: boolean }) => (
    <li data-message-id={row.id}>
      {day && <DayDivider createdAt={row.createdAt} />}
      <div data-layout="default">{row.content}</div>
    </li>
  ),
}));

const NOW = new Date(2026, 9, 30, 15);
const at = (day: number, hour: number) =>
  new Date(2026, 9, day, hour).getTime() / 1000;
const row = (id: string, createdAt: number): ChannelMessage => ({
  id,
  channelId: "alpha",
  authorId: "author",
  content: id,
  createdAt,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});
const rows = [
  row("oct-20", at(20, 9)),
  row("oct-29", at(29, 9)),
  row("oct-30", at(30, 9)),
];
const scrollIntoView = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  reading.enabled = [];
  scrollIntoView.mockClear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    left: 0,
    right: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
    window.clearTimeout(frame),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function fixture({ dateJump = true } = {}) {
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const seek = vi.fn<NonNullable<typeof owner.session.channels.seek>>();
  const loadNewer = vi.fn();
  const attach = vi.fn();
  const session = {
    ...owner.session,
    channels: { ...owner.session.channels, seek, loadNewer, attach },
  };
  const window = (overrides: Partial<ChannelWindow> = {}): ChannelWindow => ({
    channelId: "alpha",
    rows,
    status: "ready",
    hasMore: false,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
    ...overrides,
  });
  const content = (
    overrides: Partial<ChannelWindow> = {},
    revealMessageId?: string,
  ) => (
    <ToastProvider>
      <ChannelTimeline
        channelId="alpha"
        scope="date-jump"
        queries={session}
        window={window(overrides)}
        dateJump={dateJump}
        revealMessageId={revealMessageId}
        onOpenLink={() => false}
      />
    </ToastProvider>
  );
  return { owner, seek, loadNewer, attach, content };
}

async function choose(name: string) {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Yesterday, jump to date" }),
  );
  await user.click(await screen.findByRole("menuitem", { name }));
}

it("date jump is off without dateJump", () => {
  const { owner, content } = fixture({ dateJump: false });
  try {
    render(content());
    expect(screen.queryByRole("button", { name: /jump to date$/ })).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("menu choice seeks and reveals the returned row", async () => {
  const { owner, seek, content } = fixture();
  try {
    seek.mockResolvedValue("oct-29");
    render(content());
    await choose("Yesterday");
    expect(seek).toHaveBeenCalledWith(
      "alpha",
      jumpStart("yesterday", NOW),
      expect.any(AbortSignal),
    );
    const target = document.querySelector('[data-message-id="oct-29"]');
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ block: "center" }),
      ),
    );
    expect(scrollIntoView.mock.contexts).toContain(target);
    await waitFor(() =>
      expect(target?.querySelector("[data-layout]")).toHaveClass(
        styles.returnHighlight ?? "",
      ),
    );
  } finally {
    owner.dispose();
  }
});

it("shows Loading older… while seeking", async () => {
  const { owner, seek, content } = fixture();
  try {
    let resolve!: (id: string) => void;
    seek.mockReturnValue(new Promise((done) => (resolve = done)));
    render(content());
    await choose("Last week");
    expect(screen.getByRole("status")).toHaveTextContent("Loading older…");
    resolve("oct-29");
    await waitFor(() =>
      expect(screen.queryByText("Loading older…")).toBeNull(),
    );
  } finally {
    owner.dispose();
  }
});

it("a failed seek shows Couldn't jump to that date. and keeps rows", async () => {
  const { owner, seek, content } = fixture();
  try {
    seek.mockRejectedValue(new Error("offline"));
    render(content());
    await choose("Last month");
    expect(
      await screen.findByText("Couldn't jump to that date."),
    ).toBeInTheDocument();
    expect(screen.getByText("oct-20")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it("detached bottom loads newer", () => {
  const { owner, loadNewer, content } = fixture();
  try {
    render(content({ hasNewer: true }));
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    expect(loadNewer).toHaveBeenCalledWith("alpha");
  } finally {
    owner.dispose();
  }
});

it("detached bottom does not follow newer rows", async () => {
  const { owner, content } = fixture();
  const tick = () => act(() => new Promise((done) => setTimeout(done, 5)));
  const scrolls = vi.fn();
  list.scrollToIndex = scrolls;
  try {
    const view = render(content({ hasNewer: true }));
    await tick();
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    scrolls.mockClear();
    view.rerender(
      content({ hasNewer: true, rows: [...rows, row("oct-30b", at(30, 10))] }),
    );
    await tick();
    expect(scrolls).not.toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ align: "end" }),
    );
  } finally {
    list.scrollToIndex = undefined;
    owner.dispose();
  }
});

it("does not load newer while a newer page loads", () => {
  const { owner, loadNewer, content } = fixture();
  try {
    render(content({ hasNewer: true, loadingNewer: true }));
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    expect(loadNewer).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it("jump to latest attaches", () => {
  const { owner, attach, content } = fixture();
  try {
    render(content({ hasNewer: true }));
    const button = screen.getByRole("button", { name: "Jump to latest" });
    expect(button.closest("[data-visible]")).toHaveAttribute(
      "data-visible",
      "true",
    );
    fireEvent.click(button);
    expect(attach).toHaveBeenCalledWith("alpha");
  } finally {
    owner.dispose();
  }
});

it("jump to latest during a jump does not report a failure", async () => {
  const { owner, seek, attach, content } = fixture();
  try {
    let reject!: (error: unknown) => void;
    seek.mockReturnValue(new Promise((_, fail) => (reject = fail)));
    // Reattaching supersedes the store's seek.
    attach.mockImplementation(() =>
      reject(new DOMException("Stale history seek", "AbortError")),
    );
    render(content({ hasNewer: true }));
    await choose("Last week");
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(attach).toHaveBeenCalledWith("alpha");
    await act(() => new Promise((done) => setTimeout(done, 10)));
    expect(screen.queryByText("Couldn't jump to that date.")).toBeNull();
    expect(screen.queryByText("Loading older…")).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("a send during a jump does not report a failure", async () => {
  const { owner, seek, attach, content } = fixture();
  try {
    let reject!: (error: unknown) => void;
    seek.mockReturnValue(new Promise((_, fail) => (reject = fail)));
    attach.mockImplementation(() =>
      reject(new DOMException("Stale history seek", "AbortError")),
    );
    const view = render(content({ hasNewer: true }));
    await choose("Last week");
    view.rerender(content({ hasNewer: true }, "sent"));
    expect(attach).toHaveBeenCalledWith("alpha");
    await act(() => new Promise((done) => setTimeout(done, 10)));
    expect(screen.queryByText("Couldn't jump to that date.")).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("newer pages do not count as new messages", async () => {
  const { owner, content } = fixture();
  const tick = () => act(() => new Promise((done) => setTimeout(done, 5)));
  try {
    const view = render(content({ hasNewer: true }));
    await tick();
    // A reader scroll while detached leaves bottom follow.
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    const later = [...rows, row("oct-30b", at(30, 10))];
    view.rerender(content({ hasNewer: true, rows: later }));
    await tick();
    // The page that reaches the head reattaches in the same commit.
    view.rerender(content({ rows: [...later, row("oct-30c", at(30, 11))] }));
    await tick();
    expect(document.querySelector("[data-jump-to-latest]")).toHaveTextContent(
      /^Jump to latest$/,
    );
  } finally {
    owner.dispose();
  }
});

it("reading is disabled while detached", () => {
  const { owner, content } = fixture();
  try {
    const view = render(content());
    expect(reading.enabled.at(-1)).toBe(true);
    view.rerender(content({ hasNewer: true }));
    expect(reading.enabled.at(-1)).toBe(false);
  } finally {
    owner.dispose();
  }
});

it("a send while detached attaches", () => {
  const { owner, attach, content } = fixture();
  try {
    const view = render(content({ hasNewer: true }));
    expect(attach).not.toHaveBeenCalled();
    view.rerender(content({ hasNewer: true }, "sent"));
    expect(attach).toHaveBeenCalledWith("alpha");
  } finally {
    owner.dispose();
  }
});

it("unmount attaches and saves a bottom position", () => {
  const { owner, attach, content } = fixture();
  try {
    const view = render(content({ hasNewer: true }));
    view.unmount();
    expect(attach).toHaveBeenCalledWith("alpha");
    expect(
      readView<{ bottom: boolean } | null>("date-jump", "scroll:alpha", null),
    ).toMatchObject({ bottom: true });
  } finally {
    owner.dispose();
  }
});

/** Lays rows out from `tops` (viewport-relative, scroller top 0), each 300px
 * tall with its day divider in its first 20px. */
function layout(tops: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const rect = (top: number, height: number) =>
        ({
          top,
          bottom: top + height,
          left: 0,
          right: 800,
          width: 800,
          height,
          x: 0,
          y: top,
          toJSON() {},
        }) as DOMRect;
      if (this.getAttribute("aria-label") === "Channel message history")
        return rect(0, 600);
      const row = this.closest<HTMLElement>("[data-message-id]");
      const top = row ? tops[row.dataset.messageId ?? ""] : undefined;
      if (top === undefined) return rect(0, 0);
      return this === row ? rect(top, 300) : rect(top, 20);
    },
  );
}
const pinned = () => document.querySelector<HTMLElement>("[data-pinned-day]");

it("the pinned day shows the top message's day once its divider scrolls away", () => {
  const { owner, content } = fixture();
  try {
    render(content());
    layout({ "oct-20": -400, "oct-29": -100, "oct-30": 200 });
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    expect(pinned()).toHaveTextContent("Yesterday");
    // Mouse only: the dividers carry the same menu for keyboard and screen readers.
    expect(pinned()).toHaveAttribute("aria-hidden", "true");
    expect(pinned()?.querySelector("button")).toHaveAttribute("tabindex", "-1");
  } finally {
    owner.dispose();
  }
});

it("the pinned day hides while the top message's divider is in view", () => {
  const { owner, content } = fixture();
  try {
    render(content());
    layout({ "oct-20": -400, "oct-29": -100, "oct-30": 200 });
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    expect(pinned()).not.toBeNull();
    layout({ "oct-20": -300, "oct-29": 0, "oct-30": 300 });
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    expect(pinned()).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("the pinned day is off without dateJump", () => {
  const { owner, content } = fixture({ dateJump: false });
  try {
    render(content());
    layout({ "oct-20": -400, "oct-29": -100, "oct-30": 200 });
    fireEvent.scroll(screen.getByLabelText("Channel message history"));
    expect(pinned()).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("the pinned day opens the jump menu and returns focus to the timeline", async () => {
  const { owner, seek, content } = fixture();
  try {
    seek.mockReturnValue(new Promise(() => {}));
    render(content());
    layout({ "oct-20": -400, "oct-29": -100, "oct-30": 200 });
    const history = screen.getByLabelText("Channel message history");
    fireEvent.scroll(history);
    const user = userEvent.setup();
    const trigger = pinned()?.querySelector("button");
    assert.exists(trigger);
    await user.click(trigger);
    await screen.findByRole("menuitem", { name: "Last week" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(history).toHaveFocus());
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "Last week" }),
    );
    expect(seek).toHaveBeenCalledWith(
      "alpha",
      jumpStart("lastWeek", NOW),
      expect.any(AbortSignal),
    );
    // The loading status takes its place while the jump loads.
    expect(pinned()).toBeNull();
  } finally {
    owner.dispose();
  }
});
