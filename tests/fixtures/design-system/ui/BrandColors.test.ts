// @vitest-environment jsdom
import { createElement } from "react";
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BrandColors } from "./BrandColors";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
});

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
afterEach(() => {
  cleanup();
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("selects a shade and copies its CSS reference, with a manual fallback", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(createElement(BrandColors));
  fireEvent.click(screen.getByRole("button", { name: "iris 11" }));
  expect(screen.getByRole("button", { name: "cobalt 9" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "iris 11" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy CSS" }));
  expect(await screen.findByText("Copied CSS variable.")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith(
    '[data-accent="iris"][data-color-mode="light"] { color: var(--accent-11); }',
  );
  fireEvent.click(screen.getByRole("button", { name: "jade 12" }));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy CSS" }));
  expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  expect(screen.getByText("jade · var(--accent-12)")).toBeInTheDocument();
});
