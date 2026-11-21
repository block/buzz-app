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
import { SidebarCardResize, useSidebarCardHeight } from "./SidebarCardResize";

const ROW = 32;
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    run(0);
    return 1;
  });
});

type Mark = "dm" | "mention" | "channel" | "muted";

function Card({
  rows,
  marks = {},
}: {
  rows: number;
  /** Unread on a row: a DM, a mention of you, ordinary channel backlog, or a
   * mention in a muted channel. */
  marks?: Record<number, Mark>;
}) {
  const [height, resize, toggle] = useSidebarCardHeight("scope", "group:work");
  return (
    <div data-testid="card" data-height={String(height)}>
      <SidebarCardResize
        label="Work"
        height={height}
        onResize={resize}
        onToggle={toggle}
      >
        {Array.from({ length: rows }, (_, index) => `Row ${index}`).map(
          (row) => (
            <div key={row} data-card-row="">
              <button
                type="button"
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

/** jsdom has no layout: stack rows at a fixed pitch from the list's top. */
function layOut(pitch = ROW) {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-card-row]")];
  const list = rows[0]?.parentElement as HTMLElement;
  for (const [index, row] of rows.entries())
    row.getBoundingClientRect = () =>
      ({ top: index * pitch, bottom: (index + 1) * pitch }) as DOMRect;
  list.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  Object.defineProperty(list, "scrollHeight", {
    value: rows.length * pitch,
    configurable: true,
  });
  Object.defineProperty(list, "offsetHeight", {
    get: () => Number.parseFloat(list.style.maxHeight) || rows.length * pitch,
    configurable: true,
  });
  return list;
}

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
  cleanup();
  render(<Card rows={5} />);
  expect(
    document.querySelector<HTMLElement>("[data-card-row]")?.parentElement?.style
      .maxHeight,
  ).toBe(`${3 * ROW}px`);
});

it("steps a row with the keyboard, and double-click toggles full and back", () => {
  render(<Card rows={5} />);
  const list = layOut();
  const grip = screen.getByLabelText("Resize Work");
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(list.style.maxHeight).toBe(`${4 * ROW}px`);
  // A double-click's own clicks press and release without moving.
  for (const _ of [1, 2]) {
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 128 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 128 });
  }
  expect(grip.style.pointerEvents).toBe("");
  fireEvent.doubleClick(grip);
  expect(list.style.maxHeight).toBe("");
  fireEvent.doubleClick(grip);
  expect(list.style.maxHeight).toBe(`${4 * ROW}px`);
});

it("tells assistive technology how many rows show, and Enter toggles full", () => {
  render(<Card rows={5} />);
  const list = layOut();
  const grip = screen.getByRole("separator", { name: "Resize Work" });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(grip).toHaveAttribute("aria-valuenow", "4");
  expect(grip).toHaveAttribute("aria-valuemax", "5");
  expect(grip).toHaveAttribute("aria-valuetext", "4 of 5 rows");
  fireEvent.keyDown(grip, { key: "Enter" });
  expect(list.style.maxHeight).toBe("");
  expect(grip).toHaveAttribute("aria-valuenow", "5");
  fireEvent.keyDown(grip, { key: "Enter" });
  expect(list.style.maxHeight).toBe(`${4 * ROW}px`);
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

it("remembers full, not a pixel height, when the badge opens to the last row", () => {
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
    "data-height",
    String(Number.MAX_SAFE_INTEGER),
  );
});

it("hints at the grip until it has been dragged or double-clicked once", () => {
  render(<Card rows={5} />);
  layOut();
  const grip = screen.getByLabelText("Resize Work");
  const hinted = () => grip.hasAttribute("aria-describedby");
  fireEvent.focus(grip);
  expect(hinted()).toBe(true);
  // A press without a drag teaches nothing yet.
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 160 });
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 160 });
  fireEvent.focus(grip);
  expect(hinted()).toBe(true);
  fireEvent.doubleClick(grip);
  fireEvent.focus(grip);
  expect(hinted()).toBe(false);
  // Every card on this device stays quiet afterwards.
  cleanup();
  render(<Card rows={5} />);
  const next = screen.getByLabelText("Resize Work");
  fireEvent.focus(next);
  expect(next.hasAttribute("aria-describedby")).toBe(false);
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

it("shows ten rows until changed, full shows every row, and full toggles back to ten", () => {
  const restore = layOutAhead();
  try {
    render(<Card rows={60} />);
    const list = document.querySelector<HTMLElement>("[data-card-row]")
      ?.parentElement as HTMLElement;
    expect(list.style.maxHeight).toBe(`${10 * ROW}px`);
    const grip = screen.getByLabelText("Resize Work");
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 320 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 9000 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 9000 });
    // All sixty rows show, with no cap.
    expect(list.style.maxHeight).toBe("");
    // Full with nothing to go back to returns to the first ten rows.
    fireEvent.doubleClick(grip);
    expect(list.style.maxHeight).toBe(`${10 * ROW}px`);
  } finally {
    restore();
  }
});

it("makes rows past the card's edge inert and lands a saved height on a whole row", () => {
  render(<Card rows={5} />);
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
  layOut(40);
  fireEvent.doubleClick(grip);
  fireEvent.doubleClick(grip);
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
