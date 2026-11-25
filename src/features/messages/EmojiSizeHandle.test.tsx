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
import { EmojiSizeContext, type EmojiSizePreference } from "./emoji-size";
import { ResizableEmoji } from "./EmojiSizeHandle";

HTMLElement.prototype.setPointerCapture ??= () => {};

afterEach(cleanup);

function preference(initial = 100) {
  let emojiSize = initial;
  const listeners = new Set<() => void>();
  const value = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => ({ emojiSize }),
    setEmojiSize: vi.fn((size: number) => {
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
        <p data-single-emoji="">😀</p>
      </ResizableEmoji>
    </EmojiSizeContext>,
  );
  return { saved, handle: screen.getByRole("slider", { name: /emoji size/i }) };
}

const frame = (handle: HTMLElement) => handle.closest("div") as HTMLElement;

/** Glyphs render at 42px per 100%, so a pixel of travel is about 2.4%. */
function glyphSize(fontSize = "42px") {
  const real = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    (element as HTMLElement).hasAttribute("data-single-emoji")
      ? ({ fontSize } as CSSStyleDeclaration)
      : real(element),
  );
}

afterEach(() => vi.restoreAllMocks());

const press = (handle: HTMLElement, clientX = 0, clientY = 0) =>
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX, clientY });
const move = (handle: HTMLElement, clientX: number, clientY: number) =>
  fireEvent.pointerMove(handle, { pointerId: 1, clientX, clientY });
const scale = (handle: HTMLElement) =>
  frame(handle).style.getPropertyValue("--buzz-emoji-scale");

it("shows no handle without a saved preference", () => {
  render(
    <ResizableEmoji>
      <p>😀</p>
    </ResizableEmoji>,
  );
  expect(screen.getByText("😀")).toBeInTheDocument();
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
});

it("follows the pointer pixel by pixel, then saves exactly that size", () => {
  glyphSize();
  const { saved, handle } = renderEmoji();
  press(handle);
  move(handle, 21, 21);
  expect(frame(handle)).toHaveAttribute("data-emoji-scale-preview");
  expect(scale(handle)).toBe("1.5");
  move(handle, 22, 22);
  expect(scale(handle)).toBe("1.52");
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith(152);
  expect(frame(handle)).not.toHaveAttribute("data-emoji-scale-preview");
  expect(scale(handle)).toBe("");
  expect(handle).toHaveAttribute("aria-valuenow", "152");
  expect(handle).toHaveAttribute("aria-valuetext", "152%");
});

it("measures from the saved size, so travel keeps pace with the corner", () => {
  glyphSize("84px");
  const { saved, handle } = renderEmoji(preference(200));
  press(handle);
  move(handle, 21, 21);
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith(250);
});

it("stops at the smallest and largest sizes", () => {
  glyphSize();
  const { saved, handle } = renderEmoji(preference(150));
  press(handle);
  move(handle, -400, -400);
  expect(scale(handle)).toBe("1");
  move(handle, 900, 900);
  expect(scale(handle)).toBe("3");
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith(300);
});

it("changes nothing on a click", () => {
  const { saved, handle } = renderEmoji(preference(150));
  press(handle);
  move(handle, 2, 1);
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
});

it("discards the preview when the drag is cancelled", () => {
  const { saved, handle } = renderEmoji();
  press(handle);
  move(handle, 40, 40);
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(frame(handle)).not.toHaveAttribute("data-emoji-scale-preview");
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
});

it("changes size with the keyboard", () => {
  const { saved, handle } = renderEmoji();
  act(() => handle.focus());
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith(110);
  fireEvent.keyDown(handle, { key: "End" });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith(300);
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(saved.setEmojiSize).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith(290);
  fireEvent.keyDown(handle, { key: "Home" });
  expect(saved.setEmojiSize).toHaveBeenLastCalledWith(100);
  expect(handle).toHaveAttribute("aria-valuetext", "100%");
});

it("ignores a secondary button", () => {
  const { saved, handle } = renderEmoji();
  fireEvent.pointerDown(handle, { pointerId: 1, button: 2 });
  move(handle, 40, 40);
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
});

it("keeps the saved size when the pointer is cancelled", () => {
  const { saved, handle } = renderEmoji();
  press(handle);
  move(handle, 40, 40);
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  fireEvent.lostPointerCapture(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
  expect(frame(handle)).not.toHaveAttribute("data-emoji-scale-preview");
});

it("saves once when capture is lost after a drag", () => {
  glyphSize();
  const { saved, handle } = renderEmoji();
  press(handle);
  move(handle, 21, 21);
  fireEvent.lostPointerCapture(handle, { pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith(150);
});

it("follows only the pointer that started the drag", () => {
  glyphSize();
  const { saved, handle } = renderEmoji();
  press(handle);
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 40, clientY: 40 });
  fireEvent.pointerUp(handle, { pointerId: 2 });
  expect(frame(handle)).not.toHaveAttribute("data-emoji-scale-preview");
  expect(saved.setEmojiSize).not.toHaveBeenCalled();
  move(handle, 21, 21);
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith(150);
});

it("grows leftward when the handle sits at the emoji's left", () => {
  glyphSize();
  const { saved, handle } = renderEmoji();
  vi.spyOn(handle, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 24, height: 24 }),
  );
  vi.spyOn(frame(handle), "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 60 }),
  );
  press(handle, 50, 0);
  move(handle, 29, 21);
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(saved.setEmojiSize).toHaveBeenCalledExactlyOnceWith(150);
});
