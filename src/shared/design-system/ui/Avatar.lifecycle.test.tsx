// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reveals completed cached artwork on mount without waiting for a load event", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    32,
  );
  const view = render(
    <StrictMode>
      <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />
    </StrictMode>,
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "data-loaded",
    "true",
  );
  expect(view.container.querySelector("img")).not.toHaveAttribute(
    "loading",
    "lazy",
  );
});

it("uses the fallback for an already completed broken image", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    0,
  );
  render(
    <Avatar src="https://example.test/broken.png" alt="Agent" fallback="A" />,
  );
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
});

it("preserves delayed loading and error fallbacks, resetting when the source changes", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const view = render(
    <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />,
  );
  const artwork = () => {
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected avatar artwork");
    return image;
  };
  const avatar = screen.getByRole("img", { name: "Agent" });
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(149));
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(1));
  expect(avatar).toHaveTextContent("A");
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");

  view.rerender(
    <Avatar src="https://example.test/b.png" alt="Agent" fallback="A" />,
  );
  expect(artwork()).not.toHaveAttribute("data-loaded");
  expect(avatar).toHaveTextContent("");
  fireEvent.error(artwork());
  expect(avatar).toHaveTextContent("A");
  expect(document.querySelector("img")).toBeNull();
  view.rerender(
    <Avatar src="https://example.test/c.png" alt="Agent" fallback="A" />,
  );
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
