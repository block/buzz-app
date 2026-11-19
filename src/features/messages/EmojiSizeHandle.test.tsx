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
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 40 });
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
  const { saved, handle } = renderEmoji(preference("large"));
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
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith("large");
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
