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
  const { container } = render(createElement(BrandColors));
  fireEvent.click(screen.getByRole("button", { name: "iris 11" }));
  expect(screen.getByRole("button", { name: "bee 9" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "iris 11" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const scope = container.querySelector<HTMLElement>(".brand-color-selection");
  if (!scope) throw new Error("Missing selected color scope");
  scope.style.setProperty("--accent-11", "#5b4bbe");
  await screen.findByText("#5b4bbe");
  fireEvent.click(screen.getByRole("button", { name: "Copy value" }));
  expect(await screen.findByText("Copied color value.")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("#5b4bbe");
  fireEvent.click(screen.getByRole("button", { name: "citrus 12" }));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy value" }));
  expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  expect(screen.getByText("citrus · var(--accent-12)")).toBeInTheDocument();
});
