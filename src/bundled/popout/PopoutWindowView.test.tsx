// @vitest-environment jsdom
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
  dark: false,
  status: "ready",
  writable: false,
  canLoadMore: false,
  limited: false,
  loadingOlder: false,
  reading: undefined,
  readingRevision: 0,
  version: 1,
  root: row("1".repeat(64), "Root message"),
  replies: [row("2".repeat(64), "First reply")],
  ...patch,
});

it("shows the thread without chrome and reports its guard", () => {
  const act = vi.fn();
  render(<PopoutWindowView view={view()} act={act} />);
  // The OS title bar names the thread; the window itself is just the thread.
  expect(screen.queryByRole("heading")).toBeNull();
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
