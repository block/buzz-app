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
import { Avatar } from "./Avatar";

const originalDecode = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "decode",
);
beforeEach(() => {
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalDecode)
    Object.defineProperty(HTMLImageElement.prototype, "decode", originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

it("shows initials immediately while artwork is pending and recovers after failure", async () => {
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
  await act(async () => fireEvent.load(next));
  expect(next).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");
});

it("keeps cached artwork hidden until decoding succeeds without another load event", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockReturnValue(held);
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    32,
  );
  render(
    <Avatar src="https://images.test/cached.png" alt="Alex" fallback="Alex" />,
  );
  const avatar = screen.getByRole("img", { name: "Alex" });
  try {
    expect(avatar.querySelector("img")).not.toHaveAttribute("data-loaded");
    expect(avatar).toHaveTextContent("A");
  } finally {
    await act(async () => release());
  }
  expect(avatar.querySelector("img")).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");
});

it("keeps initials when loaded artwork cannot be decoded", async () => {
  vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(
    new DOMException("Invalid image", "EncodingError"),
  );
  render(
    <Avatar src="https://images.test/broken.png" alt="Alex" fallback="Alex" />,
  );
  const avatar = screen.getByRole("img", { name: "Alex" });
  const image = avatar.querySelector("img");
  if (!image) throw new Error("Missing artwork");
  await act(async () => fireEvent.load(image));
  expect(avatar.querySelector("img")).toBeNull();
  expect(avatar).toHaveTextContent("A");
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
