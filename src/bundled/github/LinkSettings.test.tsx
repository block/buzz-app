// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LinkSettings } from "./LinkSettings";
import { panelMatches } from "./links";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("keeps GitHub links out of the panel while the setting is on", async () => {
  const user = userEvent.setup();
  const pull = "https://github.com/example/project/pull/1";
  render(<LinkSettings />);
  const setting = screen.getByRole("switch", {
    name: "Open GitHub links in browser",
  });
  expect(setting).not.toBeChecked();
  expect(panelMatches(pull)).toBe(true);
  await user.click(setting);
  expect(setting).toBeChecked();
  expect(panelMatches(pull)).toBe(false);
  cleanup();
  render(<LinkSettings />);
  await user.click(screen.getByRole("switch"));
  expect(panelMatches(pull)).toBe(true);
  expect(panelMatches("https://example.com/")).toBe(false);
});

it("stays off and says so when the setting cannot be saved", async () => {
  const user = userEvent.setup();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  render(<LinkSettings />);
  const setting = screen.getByRole("switch");
  await user.click(setting);
  expect(setting).not.toBeChecked();
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t save");
});
