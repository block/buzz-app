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
import type { EmojiSize } from "../../shared/theme/service";
import { EmojiSizeContext, type EmojiSizePreference } from "./emoji-size";
import { ResizableEmoji } from "./EmojiSizeHandle";

HTMLElement.prototype.setPointerCapture ??= () => {};

afterEach(cleanup);

function preference(initial: EmojiSize = "default") {
  let emojiSize = initial;
  const listeners = new Set<() => void>();
  const value = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => ({ emojiSize }),
    setEmojiSize: vi.fn((size: EmojiSize) => {
      emojiSize = size;
      for (const listener of listeners) listener();
    }),
  };
  return value as typeof value & EmojiSizePreference;
}

function renderEmoji(saved = preference()) {
  render(
    <EmojiSizeContext value={saved}>
      <ResizableEmoji>
        <p>😀</p>
      </ResizableEmoji>
    </EmojiSizeContext>,
  );
  return { saved, handle: screen.getByRole("slider", { name: /emoji size/i }) };
}

const frame = (handle: HTMLElement) => handle.closest("div") as HTMLElement;

it("shows no handle without a saved preference", () => {
  render(
    <ResizableEmoji>
      <p>😀</p>
    </ResizableEmoji>,
  );
  expect(screen.getByText("😀")).toBeInTheDocument();
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
});

it("previews only this message while dragging, then saves on release", () => {
  const { saved, handle } = renderEmoji();
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 20 });
  expect(frame(handle)).toHaveAttribute("data-emoji-size-preview", "medium");
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 32, clientY: 32 });
  expect(frame(handle)).toHaveAttribute("data-emoji-size-preview", "large");
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith("large");
  expect(frame(handle)).not.toHaveAttribute("data-emoji-size-preview");
  expect(handle).toHaveAttribute("aria-valuetext", "Large");
});

it("snaps to the smallest and largest sizes", () => {
  const { saved, handle } = renderEmoji(preference("medium"));
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: -200, clientY: -200 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith("default");
});

it("steps to the next size on a click and wraps after the largest", () => {
  const { saved, handle } = renderEmoji(preference("huge"));
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith("default");
});

it("discards the preview when the drag is cancelled", () => {
  const { saved, handle } = renderEmoji();
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 40 });
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(frame(handle)).not.toHaveAttribute("data-emoji-size-preview");
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
});

it("changes size with the keyboard", () => {
  const { saved, handle } = renderEmoji();
  act(() => handle.focus());
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith("medium");
  fireEvent.keyDown(handle, { key: "End" });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith("huge");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(saved.setEmojiSize).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(handle, { key: "Home" });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith("default");
  expect(handle).toHaveAttribute("aria-valuetext", "Default");
});

it("ignores a secondary button", () => {
  const { saved, handle } = renderEmoji();
  fireEvent.pointerDown(handle, { pointerId: 1, button: 2 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
});

it("keeps the saved size when the pointer is cancelled", () => {
  const { saved, handle } = renderEmoji();
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 40 });
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  fireEvent.lostPointerCapture(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
  expect(frame(handle)).not.toHaveAttribute("data-emoji-size-preview");
});

it("saves once when capture is lost after a drag", () => {
  const { saved, handle } = renderEmoji();
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 20 });
  fireEvent.lostPointerCapture(handle, { pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith("medium");
});

it("follows only the pointer that started the drag", () => {
  const { saved, handle } = renderEmoji();
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 40, clientY: 40 });
  fireEvent.pointerUp(handle, { pointerId: 2 });
  expect(frame(handle)).not.toHaveAttribute("data-emoji-size-preview");
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith("medium");
});

it("grows leftward when the handle sits at the emoji's left", () => {
  const { saved, handle } = renderEmoji();
  vi.spyOn(handle, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 24, height: 24 }),
  );
  vi.spyOn(frame(handle), "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 60 }),
  );
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 50,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 18, clientY: 32 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith("large");
});

it("follows the pointer between sizes, then settles on the nearest", () => {
  // Rendered glyph sizes for each saved size, as the tokens give them.
  const display = {
    default: 42,
    medium: 52,
    large: 64,
    "extra-large": 96,
    huge: 128,
  };
  const real = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const size = (element as HTMLElement).closest<HTMLElement>(
      "[data-emoji-size-preview]",
    )?.dataset.emojiSizePreview as keyof typeof display | undefined;
    if (!size) return real(element);
    const px = display[size];
    return {
      fontSize: `${px}px`,
      lineHeight: `${px + 8}px`,
    } as CSSStyleDeclaration;
  });
  const saved = preference("large");
  render(
    <EmojiSizeContext value={saved}>
      <ResizableEmoji>
        <p data-single-emoji="">😀</p>
      </ResizableEmoji>
    </EmojiSizeContext>,
  );
  const handle = screen.getByRole("slider", { name: /emoji size/i });
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 10 });
  expect(frame(handle).style.getPropertyValue("--size-emoji-display")).toBe(
    "74px",
  );
  expect(frame(handle).style.getPropertyValue("--size-emoji-line")).toBe(
    "82px",
  );
  expect(frame(handle)).toHaveAttribute("data-emoji-size-preview", "large");
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 20 });
  expect(frame(handle)).toHaveAttribute(
    "data-emoji-size-preview",
    "extra-large",
  );
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 400 });
  expect(frame(handle).style.getPropertyValue("--size-emoji-display")).toBe(
    "128px",
  );
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 26, clientY: 26 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith("extra-large");
  expect(frame(handle).style.getPropertyValue("--size-emoji-display")).toBe("");
});
