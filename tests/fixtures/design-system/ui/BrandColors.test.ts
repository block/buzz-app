// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BrandColors } from "./BrandColors";

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
  fireEvent.click(screen.getByRole("button", { name: "violet 700" }));
  expect(screen.getByRole("button", { name: "cyan 500" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "violet 700" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy CSS" }));
  expect(await screen.findByText("Copied CSS variable.")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("var(--brand-violet-700)");
  fireEvent.click(screen.getByRole("button", { name: "lime 950" }));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy CSS" }));
  expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  expect(screen.getByText("var(--brand-lime-950)")).toBeInTheDocument();
});
