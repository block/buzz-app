// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readView, writeView } from "../../shared/view-state";
import { SidebarCardResize, useSidebarCardSize } from "./SidebarCardResize";

const ROW = 32;
afterEach(cleanup);
/** Reports from the card's size observer, as a width change would send. */
let resized: () => void = () => {};
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    run(0);
    return 1;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(report: () => void) {
        resized = () => act(report);
      }
      observe() {}
      disconnect() {}
    },
  );
});

type Mark = "dm" | "mention" | "channel" | "muted";

function Card({
  rows,
  marks = {},
  open,
}: {
  rows: number;
  /** The row of the open conversation. */
  open?: number;
  /** Unread on a row: a DM, a mention of you, ordinary channel backlog, or a
   * mention in a muted channel. */
  marks?: Record<number, Mark>;
}) {
  const [size, resize, toggle] = useSidebarCardSize("scope", "group:work");
  return (
    <div data-testid="card" data-size={String(size)}>
      <SidebarCardResize
        label="Work"
        size={size}
        onResize={resize}
        onToggle={toggle}
      >
        {Array.from({ length: rows }, (_, index) => `Row ${index}`).map(
          (row) => (
            <div key={row} data-card-row="">
              <button
                type="button"
                aria-current={
                  open === Number(row.slice(4)) ? "page" : undefined
                }
                data-channel-id={row}
                data-channel-type={
                  marks[Number(row.slice(4))] === "dm" ? "dm" : "stream"
                }
              >
                {row}
                {marks[Number(row.slice(4))] && (
                  <span
                    data-channel-unread=""
                    data-channel-muted={
                      marks[Number(row.slice(4))] === "muted" ? "" : undefined
                    }
                  />
                )}
                {/* Only a DM or a mention of you needs you; backlog and a
                    muted conversation never do. */}
                {(marks[Number(row.slice(4))] === "dm" ||
                  marks[Number(row.slice(4))] === "mention") && (
                  <span data-channel-needs-you="" aria-hidden="true" />
                )}
              </button>
            </div>
          ),
        )}
      </SidebarCardResize>
    </div>
  );
}

/** jsdom has no layout: stack rows at a fixed pitch from the list's top, or
 * wrap them as tiles, `perRow` to a line. */
function layOut(pitch = ROW, perRow = 1) {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-card-row]")];
  const list = rows[0]?.parentElement as HTMLElement;
  for (const [index, row] of rows.entries()) {
    const line = Math.floor(index / perRow);
    row.getBoundingClientRect = () =>
      ({ top: line * pitch, bottom: (line + 1) * pitch }) as DOMRect;
  }
  list.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const full = Math.ceil(rows.length / perRow) * pitch;
  Object.defineProperty(list, "scrollHeight", {
    value: full,
    configurable: true,
  });
  Object.defineProperty(list, "offsetHeight", {
    get: () => Number.parseFloat(list.style.maxHeight) || full,
    configurable: true,
  });
  return list;
}

const saved = () => readView<unknown>("scope", "sidebar:card-sizes", {});

it("offers a grip only when there is a row to hide", async () => {
  const { rerender } = render(<Card rows={1} />);
  expect(screen.queryByLabelText("Resize Work")).toBeNull();
  rerender(<Card rows={3} />);
  expect(await screen.findByLabelText("Resize Work")).toBeInTheDocument();
});

it("follows the pointer, settles on a whole row, and remembers it", () => {
  render(<Card rows={5} />);
  const list = layOut();
  const grip = screen.getByLabelText("Resize Work");
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 160 });
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 110 });
  expect(list.style.maxHeight).toBe("110px");
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 110 });
  expect(list.style.maxHeight).toBe(`${3 * ROW}px`);
  expect(saved()).toEqual({ "group:work": 3 });
  cleanup();
  render(<Card rows={5} />);
  expect(screen.getByTestId("card")).toHaveAttribute("data-size", "3");
  expect(
    [...document.querySelectorAll("[data-card-row]")].map((row) =>
      row.hasAttribute("data-card-clipped"),
    ),
  ).toEqual([false, false, false, true, true]);
});

it("keeps a card's count across a list, icons and back, and never saves the rounding", () => {
  render(<Card rows={20} />);
  const list = layOut();
  resized();
  expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
  // As icons, five to a line: seven rounds up to fill the second line.
  layOut(ROW, 5);
  resized();
  expect(list.style.maxHeight).toBe(`${2 * ROW}px`);
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "10");
  // A wider sidebar fits all seven on one line, which shows full.
  layOut(ROW, 8);
  resized();
  expect(list.style.maxHeight).toBe(`${ROW}px`);
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "8");
  // Back as a list: exactly seven, and nothing was ever saved.
  layOut();
  resized();
  expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
  expect(saved()).toEqual({});
});

it("saves the tiles through the row an icon drag settles on", () => {
  render(<Card rows={20} />);
  const list = layOut(ROW, 5);
  resized();
  const grip = screen.getByLabelText("Resize Work");
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 64 });
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 100 });
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 100 });
  // Three lines of five.
  expect(list.style.maxHeight).toBe(`${3 * ROW}px`);
  expect(saved()).toEqual({ "group:work": 15 });
  layOut();
  resized();
  expect(list.style.maxHeight).toBe(`${15 * ROW}px`);
});

it("shows the default for a card whose old pixel height was saved", () => {
  writeView("scope", "sidebar:card-heights", { "group:work": 3 * ROW });
  render(<Card rows={20} />);
  const list = layOut();
  resized();
  expect(screen.getByTestId("card")).toHaveAttribute("data-size", "undefined");
  expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
});

it("steps a row with the keyboard, and double-click opens full and resets to seven", () => {
  render(<Card rows={9} />);
  const list = layOut();
  const grip = screen.getByLabelText("Resize Work");
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(list.style.maxHeight).toBe(`${8 * ROW}px`);
  // A double-click's own clicks press and release without moving.
  for (const _ of [1, 2]) {
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 128 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 128 });
  }
  expect(grip.style.pointerEvents).toBe("");
  fireEvent.doubleClick(grip);
  expect(list.style.maxHeight).toBe("");
  // Closing full resets to the default, not the dragged height.
  fireEvent.doubleClick(grip);
  expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
});

it("tells assistive technology how many rows show, and Enter toggles full", () => {
  render(<Card rows={9} />);
  const list = layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(grip).toHaveAttribute("aria-valuenow", "8");
  expect(grip).toHaveAttribute("aria-valuemax", "9");
  expect(grip).toHaveAttribute("aria-valuetext", "8 of 9 conversations");
  fireEvent.keyDown(grip, { key: "Enter" });
  expect(list.style.maxHeight).toBe("");
  expect(grip).toHaveAttribute("aria-valuenow", "9");
  fireEvent.keyDown(grip, { key: "Enter" });
  expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
});

it("keeps the grip showing while rows are past the card's edge", () => {
  render(<Card rows={5} />);
  layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(grip).toHaveAttribute("data-more");
  fireEvent.keyDown(grip, { key: "Enter" });
  expect(grip).not.toHaveAttribute("data-more");
});

it("counts unread that waits on you past the edge, and opens to the lowest", () => {
  render(<Card rows={6} marks={{ 3: "dm", 4: "channel", 5: "mention" }} />);
  const list = layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  expect(screen.queryByRole("button", { name: /unread/ })).toBeNull();
  for (const _ of [1, 2, 3]) fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(list.style.maxHeight).toBe(`${3 * ROW}px`);
  // The DM and the mention count; ordinary channel backlog does not.
  const badge = screen.getByRole("button", {
    name: "Show 2 unread conversations below in Work",
  });
  expect(badge).toHaveTextContent("2 unread");
  fireEvent.click(badge);
  // The mention is the last row, so the card opens full.
  expect(list.style.maxHeight).toBe("");
  expect(screen.queryByRole("button", { name: /unread/ })).toBeNull();
});

it("opens only as far as the lowest unread that waits on you", () => {
  render(<Card rows={6} marks={{ 3: "mention", 5: "channel" }} />);
  const list = layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  for (const _ of [1, 2, 3]) fireEvent.keyDown(grip, { key: "ArrowUp" });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Show 1 unread conversation below in Work",
    }),
  );
  expect(list.style.maxHeight).toBe(`${4 * ROW}px`);
  expect(screen.queryByRole("button", { name: /unread/ })).toBeNull();
});

it("follows a marker that changes in place, and leaves muted ones out", async () => {
  const { rerender } = render(<Card rows={5} marks={{ 4: "channel" }} />);
  layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  for (const _ of [1, 2]) fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(screen.queryByRole("button", { name: /unread/ })).toBeNull();
  // The same row's backlog becomes a mention of you.
  rerender(<Card rows={5} marks={{ 4: "mention" }} />);
  await act(async () => {});
  expect(
    screen.getByRole("button", {
      name: "Show 1 unread conversation below in Work",
    }),
  ).toBeInTheDocument();
  // Then its channel is muted, without the row re-rendering: the row stops
  // needing you, so its marker goes while the muted evidence stays.
  await act(async () => {
    document
      .querySelector('[data-channel-id="Row 4"] [data-channel-unread]')
      ?.setAttribute("data-channel-muted", "");
    document
      .querySelector('[data-channel-id="Row 4"] [data-channel-needs-you]')
      ?.remove();
  });
  expect(screen.queryByRole("button", { name: /unread/ })).toBeNull();
});

it("never counts a muted conversation past the edge", () => {
  render(<Card rows={5} marks={{ 3: "muted", 4: "dm" }} />);
  layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  for (const _ of [1, 2]) fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(
    screen.getByRole("button", {
      name: "Show 1 unread conversation below in Work",
    }),
  ).toBeInTheDocument();
});

it("hands focus to the grip when the badge is used from the keyboard", () => {
  render(<Card rows={5} marks={{ 3: "mention" }} />);
  layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  for (const _ of [1, 2]) fireEvent.keyDown(grip, { key: "ArrowUp" });
  const badge = screen.getByRole("button", {
    name: "Show 1 unread conversation below in Work",
  });
  badge.focus();
  // Keyboard activation clicks with no pointer detail.
  fireEvent.click(badge, { detail: 0 });
  expect(badge).not.toBeInTheDocument();
  expect(grip).toHaveFocus();
});

it("remembers full when the badge opens to the last row", () => {
  render(<Card rows={5} marks={{ 4: "dm" }} />);
  const list = layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  for (const _ of [1, 2]) fireEvent.keyDown(grip, { key: "ArrowUp" });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Show 1 unread conversation below in Work",
    }),
  );
  expect(list.style.maxHeight).toBe("");
  expect(screen.getByTestId("card")).toHaveAttribute(
    "data-size",
    String(Number.MAX_SAFE_INTEGER),
  );
});

/** Lay rows out before the first render, so the default clip can measure. */
function layOutAhead() {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute("data-card-row")) return { top: 0 } as DOMRect;
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      return { top: index * ROW, bottom: (index + 1) * ROW } as DOMRect;
    });
  const height = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.querySelectorAll("[data-card-row]").length * ROW;
    });
  return () => {
    rect.mockRestore();
    height.mockRestore();
  };
}

it("shows seven rows until changed, full shows every row, and full toggles back to seven", () => {
  const restore = layOutAhead();
  try {
    render(<Card rows={60} />);
    const list = document.querySelector<HTMLElement>("[data-card-row]")
      ?.parentElement as HTMLElement;
    expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
    const grip = screen.getByLabelText("Resize Work");
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 320 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 9000 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 9000 });
    // All sixty rows show, with no cap.
    expect(list.style.maxHeight).toBe("");
    // Closing full returns to the first seven rows.
    fireEvent.doubleClick(grip);
    expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
  } finally {
    restore();
  }
});

it("makes rows past the card's edge inert and lands a saved height on a whole row", async () => {
  const { rerender } = render(<Card rows={5} />);
  const list = layOut();
  const grip = screen.getByLabelText("Resize Work");
  // Release between rows two and three, then change the text size so the
  // saved height no longer falls on a row edge.
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 160 });
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 70 });
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 70 });
  expect(list.style.maxHeight).toBe(`${2 * ROW}px`);
  const rows = [...list.querySelectorAll<HTMLElement>("[data-card-row]")];
  expect(rows.map((row) => row.inert === true)).toEqual([
    false,
    false,
    true,
    true,
    true,
  ]);
  expect(rows[2]).toHaveAttribute("data-card-clipped");
  // Larger text: rows are now 40px tall, so 64px is nearest to row two's end.
  // A row arriving and leaving makes the card measure again.
  await act(async () => rerender(<Card rows={6} />));
  layOut(40);
  await act(async () => rerender(<Card rows={5} />));
  expect(list.style.maxHeight).toBe("80px");
  expect(rows.map((row) => row.inert === true)).toEqual([
    false,
    false,
    true,
    true,
    true,
  ]);
  // A row leaving the list is inert on its own; clipping never wakes it.
  (rows[0] as HTMLElement).inert = true;
  fireEvent.doubleClick(grip);
  expect(rows.map((row) => row.inert === true)).toEqual([
    true,
    false,
    false,
    false,
    false,
  ]);
});

it("pins the open conversation under the last row while it sorts past the edge", () => {
  const { rerender } = render(<Card rows={12} open={10} />);
  const list = layOut();
  resized();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-card-row]")];
  const pinned = rows[10] as HTMLElement;
  // Seven rows, then the open one, which is neither inert nor clipped.
  expect(pinned).toHaveAttribute("data-card-pinned");
  expect(pinned.style.getPropertyValue("--card-pin-top")).toBe(`${7 * ROW}px`);
  expect(list.style.maxHeight).toBe(`${8 * ROW}px`);
  expect(pinned.inert).toBe(false);
  expect(pinned).not.toHaveAttribute("data-card-clipped");
  expect(rows[7]).toHaveAttribute("data-card-clipped");
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "7");
  // The size it saves is the card's own, not counting the pinned row.
  expect(saved()).toEqual({});
  // Opening one that shows, or none, puts it back.
  rerender(<Card rows={12} open={2} />);
  resized();
  expect(pinned).not.toHaveAttribute("data-card-pinned");
  expect(pinned).toHaveAttribute("data-card-clipped");
  expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
});

it("steps the keyboard from the card's own edge, not the pinned row", () => {
  render(<Card rows={12} open={10} />);
  const list = layOut();
  resized();
  fireEvent.keyDown(screen.getByLabelText("Resize Work"), { key: "ArrowUp" });
  expect(saved()).toEqual({ "group:work": 6 });
  expect(list.style.maxHeight).toBe(`${7 * ROW}px`);
});
