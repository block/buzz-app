// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PageSearch, type SearchServices } from "./PageSearch";
import type { RegisteredPage } from "../../features/pages/service";
import {
  createShortcutBindings,
  SHORTCUT_BINDINGS_KEY,
} from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("keeps typing focus while arrows select results and Enter opens the selection", async () => {
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
  const input = within(dialog).getByRole("combobox", { name: "Search Buzz" });
  const home = within(dialog).getByRole("option", { name: "Home" });
  const settings = within(dialog).getByRole("option", { name: "Settings" });
  for (const [attribute, value] of Object.entries({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    autocomplete: "off",
  }))
    expect(input).toHaveAttribute(attribute, value);
  await vi.waitFor(() => expect(input).toHaveFocus());
  for (const [key, result] of [
    ["ArrowDown", home],
    ["ArrowDown", settings],
    ["ArrowDown", settings],
    ["ArrowUp", home],
    ["ArrowUp", home],
  ] as const) {
    await user.keyboard(`{${key}}`);
    expect(input).toHaveFocus();
    expect(result).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", result.id);
  }
  fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
    fireEvent.keyDown(input, { key: "ArrowDown", [modifier]: true });
    fireEvent.keyDown(input, { key: "Enter", [modifier]: true });
  }
  expect(home).toHaveAttribute("aria-selected", "true");
  expect(home).toHaveAttribute("data-selected", "true");
  expect(settings).toHaveAttribute("aria-selected", "false");
  expect(home).not.toHaveAttribute("aria-current", "page");
  expect(select).not.toHaveBeenCalled();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
});

it("clears selection on typing, handles empty results, and retains pointer activation", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(<PageSearch pages={[]} onSelect={select} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const input = await screen.findByRole("combobox", { name: "Search Buzz" });
  await user.click(input);
  await user.keyboard("{ArrowDown}");
  await user.type(input, "missing");
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(input).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "sett");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("option", { name: "Settings" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
});

it("invalidates selection when result identities change, even at the same index", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const select = vi.fn();
  const user = userEvent.setup();
  const page = (key: string): RegisteredPage => ({
    key,
    pluginId: "test",
    id: key,
    title: "Target",
    revision: "bundled",
    component: () => null,
  });
  const first = page("test/first");
  const second = page("test/second");
  const { rerender } = render(<PageSearch pages={[first]} onSelect={select} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const input = await screen.findByRole("combobox", { name: "Search Buzz" });
  await user.type(input, "Target");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "Target" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Late arrivals may reorder results, but cannot redirect the selected destination.
  rerender(
    <PageSearch
      pages={[{ ...second, title: "Target ahead" }, first]}
      onSelect={select}
    />,
  );
  expect(screen.getByRole("option", { name: /^Target$/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name: /^Target$/ }).id,
  );
  rerender(<PageSearch pages={[second]} onSelect={select} />);
  expect(input).toHaveFocus();
  expect(input).toHaveValue("Target");
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.keyboard("{Enter}");
  expect(select).not.toHaveBeenCalled();
  rerender(<PageSearch pages={[first]} onSelect={select} />);
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.keyboard("{ArrowUp}{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("test/first");
});

it("shows the live search shortcut in the trigger hint and follows a rebind", async () => {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  try {
    // Only the shortcut services are read while the dialog is closed.
    render(
      <PageSearch
        pages={[]}
        onSelect={vi.fn()}
        services={
          { shortcuts, shortcutBindings: bindings } as unknown as SearchServices
        }
      />,
    );
    // The title renders as a focus/hover tooltip rather than a native attribute.
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Search Buzz" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Search Buzz (⌘K)",
    );
    act(() =>
      bindings.set("global-search", { key: "p", mod: true, shift: true }),
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search Buzz (⇧⌘P)");
    act(() => bindings.reset());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search Buzz (⌘K)");
  } finally {
    Reflect.deleteProperty(navigator, "platform");
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("renders a restored prototype-named search key and remains resettable", async () => {
  localStorage.setItem(
    SHORTCUT_BINDINGS_KEY,
    JSON.stringify({ "global-search": { key: "constructor", mod: true } }),
  );
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  try {
    render(
      <PageSearch
        pages={[]}
        onSelect={vi.fn()}
        services={
          { shortcuts, shortcutBindings: bindings } as unknown as SearchServices
        }
      />,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Search Buzz" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("constructor");
    act(() => bindings.reset());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Ctrl+K");
  } finally {
    bindings.dispose();
    localStorage.clear();
    await root.fiber.dispose();
  }
});
