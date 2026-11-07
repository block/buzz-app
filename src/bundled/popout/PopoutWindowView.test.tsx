// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { PopoutView } from "../../features/popout/window";
import { PopoutWindowView } from "./PopoutWindowView";
import { popoutThreadRoot } from ".";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(cleanup);

const row = (id: string, text: string) => ({
  id,
  author: "Ada",
  authorId: "a".repeat(64),
  channelId: "channel",
  attachments: [],
  picture: null,
  text,
  time: 1_700_000_000,
  delivery: "seen" as const,
});
const view = (patch: Partial<PopoutView> = {}): PopoutView => ({
  title: "Design",
  scope: "https://relay.test:viewer",
  dark: false,
  status: "ready",
  writable: false,
  canLoadMore: false,
  limited: false,
  loadingOlder: false,
  reading: undefined,
  readingRevision: 0,
  operations: [],
  following: false,
  isDm: false,
  thread: true,
  version: 1,
  root: row("1".repeat(64), "Root message"),
  replies: [row("2".repeat(64), "First reply")],
  ...patch,
});

it("names what it shows, as Slack's pop-out does, and reports its guard", () => {
  const act = vi.fn();
  const { rerender } = render(<PopoutWindowView view={view()} act={act} />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Thread #Design",
  );
  rerender(
    <PopoutWindowView view={view({ isDm: true, title: "Ada" })} act={act} />,
  );
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Thread Ada",
  );
  rerender(<PopoutWindowView view={view()} act={act} />);
  expect(screen.getByText("Root message")).toBeTruthy();
  expect(screen.getByText("First reply")).toBeTruthy();
  // The guard is reported natively from the start: nothing is held yet.
  expect(act).toHaveBeenCalledWith("guard", "0");
  expect(screen.getByText("This thread is read-only here.")).toBeTruthy();
});

it("asks before a guarded close and confirms through the owner", () => {
  const act = vi.fn();
  const { rerender } = render(<PopoutWindowView view={view()} act={act} />);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  rerender(<PopoutWindowView view={view({ closeRequested: 1 })} act={act} />);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  rerender(<PopoutWindowView view={view({ closeRequested: 2 })} act={act} />);
  fireEvent.click(screen.getByRole("button", { name: "Close window" }));
  expect(act).toHaveBeenCalledWith("close");
});

it("goes read-only with a notice while the owner is away", () => {
  render(
    <PopoutWindowView
      view={view({ detached: true, writable: true })}
      act={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toMatch(/reconnecting/);
  expect(screen.queryByText("This thread is read-only here.")).toBeNull();
});

it("sends Buzz links to main and leaves web links to the OS opener", () => {
  const act = vi.fn();
  render(
    <PopoutWindowView
      view={view({
        root: row(
          "1".repeat(64),
          "[Example](https://example.com) and buzz://channel/abc",
        ),
        replies: [],
      })}
      act={act}
    />,
  );
  fireEvent.click(screen.getByRole("link", { name: "Example" }));
  expect(act.mock.calls.filter((c) => c[0] === "openLink")).toEqual([]);
  const buzz = screen
    .getAllByRole("link")
    .find((link) => link.getAttribute("href")?.startsWith("buzz:"));
  if (buzz) {
    fireEvent.click(buzz);
    expect(act).toHaveBeenCalledWith(
      "openLink",
      expect.stringMatching(/^buzz:/),
    );
  }
});

it("offers the action only for delivered messages that have a thread", () => {
  const base = {
    id: "3".repeat(64),
    channelId: "c",
    authorId: "a".repeat(64),
    createdAt: 1,
    content: "",
    attachments: [],
    mentions: [],
    reactions: [],
    participants: [],
  };
  expect(popoutThreadRoot({ ...base, replyCount: 0 })).toBeUndefined();
  expect(popoutThreadRoot({ ...base, replyCount: 2 })).toBe(base.id);
  expect(
    popoutThreadRoot({ ...base, replyCount: 0, threadRootId: "r".repeat(64) }),
  ).toBe("r".repeat(64));
  expect(
    popoutThreadRoot({ ...base, replyCount: 2, delivery: "failed" }),
  ).toBeUndefined();
});

it("shows projected reactions even before the bridge connects", () => {
  render(
    <PopoutWindowView
      view={view({
        root: {
          ...row("1".repeat(64), "Root message"),
          reactions: [
            {
              content: "👍",
              events: [{ id: "9".repeat(64), authorId: "a".repeat(64) }],
            },
          ],
        },
        replies: [],
      })}
      act={vi.fn()}
    />,
  );
  expect(screen.getByText("👍")).toBeTruthy();
});

it("shows a conversation as a timeline with day dividers, drills into a row's thread in place and offers the way back", () => {
  const act = vi.fn();
  const day = 86_400;
  const conversation = view({
    thread: false,
    root: undefined,
    writable: true,
    replies: [
      { ...row("1".repeat(64), "Monday"), time: 1_700_000_000 },
      {
        ...row("2".repeat(64), "Tuesday, with a thread"),
        time: 1_700_000_000 + day,
        replyCount: 3,
      },
    ],
  });
  const { rerender } = render(
    <PopoutWindowView view={conversation} act={act} />,
  );
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "#Design",
  );
  expect(
    screen.queryByRole("button", { name: "Back to conversation" }),
  ).toBeNull();
  expect(screen.getByRole("log", { name: "Messages" })).toBeTruthy();
  // One divider per day shown.
  expect(document.querySelectorAll("[data-day]")).toHaveLength(2);
  fireEvent.click(
    screen.getByRole("button", { name: /View thread: 3 replies/ }),
  );
  expect(act).toHaveBeenCalledWith("openThread", "2".repeat(64));
  rerender(
    <PopoutWindowView
      view={view({
        thread: true,
        canGoBack: true,
        root: row("2".repeat(64), "Tuesday, with a thread"),
        replies: [],
      })}
      act={act}
    />,
  );
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Thread #Design",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
  expect(act).toHaveBeenCalledWith("back");
});

it("shows membership activity as one notice per run and says who is typing or working, in main's words", () => {
  const act = vi.fn();
  const ada = "a".repeat(64);
  const bob = "b".repeat(64);
  const carol = "c".repeat(64);
  const conversation = view({
    thread: false,
    root: undefined,
    replies: [
      row("1".repeat(64), "Hello"),
      {
        ...row("2".repeat(64), ""),
        authorId: ada,
        membership: { type: "member_joined", actor: carol, target: ada },
        mentionNames: { [ada]: "Ada", [carol]: "Carol" },
      },
      {
        ...row("3".repeat(64), ""),
        authorId: bob,
        membership: { type: "member_joined", actor: carol, target: bob },
        mentionNames: { [bob]: "Bob", [carol]: "Carol" },
      },
      row("4".repeat(64), "Welcome"),
    ],
    typing: { humans: ["Ada", "Bob"], more: 1, agents: ["Echo"] },
  });
  render(<PopoutWindowView view={conversation} act={act} />);
  expect(screen.getByText("Hello")).toBeTruthy();
  expect(screen.getByText("Welcome")).toBeTruthy();
  const notices = document.querySelectorAll("[data-membership-row]");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.textContent).toMatch(/Carol/);
  expect(notices[0]?.textContent).toMatch(/Ada/);
  expect(notices[0]?.textContent).toMatch(/Bob/);
  expect(
    document.querySelector("[data-conversation-activity]")?.textContent,
  ).toBe("Echo is working. Ada, Bob and 1 others are typing");
});
