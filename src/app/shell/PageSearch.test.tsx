// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PageSearch } from "./PageSearch";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("moves from the search input through results and back, then opens with Enter", async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(<PageSearch pages={[]} onSelect={select} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  const input = within(dialog).getByRole("searchbox", { name: "Search Buzz" });
  expect(input).toHaveAttribute("spellcheck", "false");
  expect(input).toHaveAttribute("autocorrect", "off");
  expect(input).toHaveAttribute("autocapitalize", "off");
  expect(input).toHaveAttribute("autocomplete", "off");
  const home = within(dialog).getByRole("button", { name: "Home" });
  const settings = within(dialog).getByRole("button", { name: "Settings" });
  await vi.waitFor(() => expect(input).toHaveFocus());
  await user.keyboard("{ArrowDown}");
  expect(home).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(settings).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(input).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(settings).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(home).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  expect(input).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledWith("home");
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
});
