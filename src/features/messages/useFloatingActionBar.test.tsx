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
import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFloatingActionBar } from "./useFloatingActionBar";

let mediaMatches = true;
let mediaListeners: Set<() => void>;
const show = vi.fn(function (this: HTMLElement) {
  this.dataset.shown = "true";
});
const hide = vi.fn(function (this: HTMLElement) {
  delete this.dataset.shown;
});
const disconnect = vi.fn();

beforeEach(() => {
  mediaMatches = true;
  mediaListeners = new Set();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return mediaMatches;
    },
    addEventListener: (_: string, listener: () => void) =>
      mediaListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      mediaListeners.delete(listener),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect = disconnect;
    },
  );
  // jsdom has no top layer. These shims observe the hook's visibility contract;
  // actual painting, geometry and focus order belong to the browser spec.
  HTMLElement.prototype.showPopover = show;
  HTMLElement.prototype.hidePopover = hide;
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function Harness({ open = false, expanded = false, hasPicker = true }) {
  const row = useRef<HTMLDivElement>(null);
  return (
    <StrictMode>
      <div ref={row} data-testid="row">
        <button type="button">Avatar</button>
        <Controls
          row={row}
          open={open}
          expanded={expanded}
          hasPicker={hasPicker}
        />
      </div>
      <button type="button">Outside</button>
    </StrictMode>
  );
}
function Controls({
  row,
  open,
  expanded,
  hasPicker,
}: {
  row: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  expanded: boolean;
  hasPicker: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const floating = useFloatingActionBar(row, bar, slot, open, "timeline");
  return (
    <div ref={slot}>
      <div
        ref={bar}
        data-testid="bar"
        popover={floating ? "manual" : undefined}
      >
        {hasPicker && (
          <button type="button" aria-haspopup="dialog" aria-expanded={expanded}>
            Picker
          </button>
        )}
        {/* Expanded branches are not open popups and must not reveal the bar. */}
        <button type="button" aria-expanded="true">
          Collapse branch
        </button>
      </div>
    </div>
  );
}

it("retains reveal across row/bar hover, focus, menu and expanded picker transitions", async () => {
  const { rerender } = render(<Harness />);
  const row = screen.getByTestId("row");
  const bar = screen.getByTestId("bar");
  expect(bar).toHaveAttribute("popover", "manual");
  expect(bar).not.toHaveAttribute("data-shown");
  fireEvent.pointerEnter(row);
  expect(bar).toHaveAttribute("data-shown");
  fireEvent.pointerLeave(row);
  expect(bar).not.toHaveAttribute("data-shown");
  act(() => screen.getByRole("button", { name: "Avatar" }).focus());
  expect(bar).toHaveAttribute("data-shown");
  act(() =>
    screen.getByRole("button", { name: "Picker", hidden: true }).focus(),
  );
  expect(bar).toHaveAttribute("data-shown");
  act(() => screen.getByRole("button", { name: "Outside" }).focus());
  expect(bar).not.toHaveAttribute("data-shown");
  rerender(<Harness open />);
  expect(bar).toHaveAttribute("data-shown");
  fireEvent.pointerEnter(row);
  fireEvent.pointerLeave(row);
  expect(bar).toHaveAttribute("data-shown");
  rerender(<Harness open expanded />);
  rerender(<Harness expanded />);
  expect(bar).toHaveAttribute("data-shown");
  rerender(<Harness />);
  await waitFor(() => expect(bar).not.toHaveAttribute("data-shown"));
  // Removing a focused branch/picker control emits no native focusout.
  act(() =>
    screen.getByRole("button", { name: "Picker", hidden: true }).focus(),
  );
  expect(bar).toHaveAttribute("data-shown");
  rerender(<Harness hasPicker={false} />);
  await waitFor(() => expect(bar).not.toHaveAttribute("data-shown"));
  expect(screen.getByTestId("bar")).toBe(bar);
});

it("leaves coarse/narrow controls static and cleans up floating mode on media changes and unmount", () => {
  mediaMatches = false;
  const { unmount } = render(<Harness />);
  const row = screen.getByTestId("row");
  const bar = screen.getByTestId("bar");
  fireEvent.pointerEnter(row);
  expect(bar).not.toHaveAttribute("popover");
  expect(show).not.toHaveBeenCalled();
  act(() => {
    mediaMatches = true;
    for (const listener of mediaListeners) listener();
  });
  fireEvent.pointerEnter(row);
  expect(bar).toHaveAttribute("popover", "manual");
  expect(bar).toHaveAttribute("data-shown");
  act(() => {
    mediaMatches = false;
    for (const listener of mediaListeners) listener();
  });
  expect(bar).not.toHaveAttribute("popover");
  expect(bar.style.top).toBe("");
  expect(disconnect).toHaveBeenCalled();
  unmount();
  expect(mediaListeners.size).toBe(0);
});
