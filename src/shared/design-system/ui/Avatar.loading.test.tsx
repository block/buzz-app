// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows initials immediately while artwork is pending and recovers after failure", () => {
  const view = render(
    <Avatar src="https://images.test/first.png" alt="Alex" fallback="Alex" />,
  );
  const avatar = screen.getByRole("img", { name: "Alex" });
  const image = avatar.querySelector("img");
  expect(avatar).toHaveTextContent("A");
  expect(image).not.toHaveAttribute("data-loaded");
  if (!image) throw new Error("Missing artwork");
  fireEvent.error(image);
  expect(avatar.querySelector("img")).toBeNull();
  expect(avatar).toHaveTextContent("A");

  view.rerender(
    <Avatar src="https://images.test/next.png" alt="Alex" fallback="Alex" />,
  );
  const next = avatar.querySelector("img");
  if (!next) throw new Error("Missing replacement artwork");
  expect(avatar).toHaveTextContent("A");
  fireEvent.load(next);
  expect(next).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");
});

it("reveals an already complete image without waiting for another load event", () => {
  // The browser can finish a cached image before React attaches its load handler.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    32,
  );
  render(
    <Avatar src="https://images.test/cached.png" alt="Alex" fallback="Alex" />,
  );
  const avatar = screen.getByRole("img", { name: "Alex" });
  expect(avatar.querySelector("img")).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");
});

it("keeps initials for a complete image with no intrinsic width", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    0,
  );
  render(
    <Avatar src="https://images.test/broken.png" alt="Alex" fallback="Alex" />,
  );
  const avatar = screen.getByRole("img", { name: "Alex" });
  expect(avatar.querySelector("img")).not.toHaveAttribute("data-loaded");
  expect(avatar).toHaveTextContent("A");
});
