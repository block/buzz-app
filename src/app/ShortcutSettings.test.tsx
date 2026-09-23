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
import { ShortcutSettings } from "./ShortcutSettings";
import type { Shortcut } from "../features/shortcuts/bindings";
import {
  createShortcutBindings,
  SHORTCUT_BINDINGS_KEY,
} from "../features/shortcuts/preferences";
import { ShortcutsService } from "../features/shortcuts/service";
import type { PluginManager } from "../plugins/manager";
import type { PluginInfo } from "../plugins/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const info = (id: string, name: string): PluginInfo => ({
  manifest: { id, name, apiVersion: 1 },
  source: "external",
  enabled: true,
  revision: "one",
  previous: null,
  reloadable: false,
  error: null,
});
const catalog = (
  plugins: PluginInfo[],
): Pick<PluginManager, "subscribe" | "snapshot"> => {
  const snapshot = {
    configuration: {
      status: "ready" as const,
      catalog: { profile: "", location: "", plugins },
      externalPluginsPaused: false,
    },
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  return { subscribe: () => () => {}, snapshot: () => snapshot };
};

// jsdom reports an empty platform, so the real dispatcher on `window` treats
// Control as Mod; the page follows the same test unless told otherwise.
async function harness() {
  const root = new Context();
  const inactive = new Set<string>();
  const statusListeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: (id: string) => !inactive.has(id),
    subscribe: (listener: () => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const runs = {
    settings: vi.fn(),
    search: vi.fn(),
    grow: vi.fn(),
    increment: vi.fn(),
    terminal: vi.fn(),
  };
  shortcuts.registerHost({
    id: "settings",
    title: "Open Settings",
    binding: { key: ",", mod: true },
    run: runs.settings,
  });
  shortcuts.registerHost({
    id: "global-search",
    title: "Search Buzz",
    binding: { key: "k", mod: true },
    run: runs.search,
  });
  shortcuts.registerHost({
    id: "font-increase",
    title: "Increase text size",
    binding: [
      { key: "=", mod: true },
      { key: "+", mod: true },
      { key: "=", mod: true, shift: true },
      { key: "+", mod: true, shift: true },
    ],
    run: runs.grow,
  });
  const contribute = (id: string, shortcut: Shortcut) =>
    root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => {
        ctx.shortcuts.register(shortcut);
      })
      .await();
  await contribute("example.counter", {
    id: "increment",
    title: "Increment shortcut counter",
    binding: { key: "k", mod: true, shift: true },
    run: runs.increment,
  });
  await contribute("buzz.terminal", {
    id: "toggle",
    title: "Toggle channel terminal",
    binding: { key: "j", mod: true },
    run: runs.terminal,
  });
  return {
    runs,
    bindings,
    shortcuts,
    plugins: catalog([
      info("example.counter", "Shortcut counter"),
      info("buzz.terminal", "Terminal"),
    ]),
    setActive(id: string, active: boolean) {
      if (active) inactive.delete(id);
      else inactive.add(id);
      for (const listener of statusListeners) listener();
    },
    /** Dispatch to the window listener from a non-editable target. */
    press: (key: string, init: KeyboardEventInit = {}) =>
      fireEvent.keyDown(document.body, { key, ctrlKey: true, ...init }),
    async dispose() {
      bindings.dispose();
      await root.fiber.dispose();
    },
  };
}
const row = (title: string) => screen.getByRole("article", { name: title });
const change = (title: string) =>
  screen.getByRole("button", { name: `Change shortcut for ${title}` });
const capture = (title: string) =>
  screen.getByRole("textbox", { name: `New shortcut for ${title}` });

it("lists live host and plugin shortcuts grouped by owner, searchable, and follows plugin state", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
        apple
      />,
    );
    const groups = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(groups).toEqual([
      "Shortcuts",
      "Buzz",
      "Shortcut counter",
      "Terminal",
    ]);
    expect(
      screen
        .getAllByRole("article")
        .map(
          (article) =>
            within(article).getByRole("heading", { level: 3 }).textContent,
        ),
    ).toEqual([
      "Increase text size",
      "Open Settings",
      "Search Buzz",
      "Increment shortcut counter",
      "Toggle channel terminal",
    ]);
    // Chips show the first alias with glyphs; the label reads as words.
    const grow = row("Increase text size");
    expect(within(grow).getByText("Command =")).toHaveClass("sr-only");
    const chips = grow.querySelectorAll("kbd kbd");
    expect([...chips].map((chip) => chip.textContent)).toEqual(["⌘", "="]);
    expect(chips[0]?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(grow.querySelector("[data-design-pass='pending']")).toHaveAttribute(
      "data-binding",
      "⌘=",
    );
    expect(
      within(row("Increment shortcut counter")).getByText("Shift Command K"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Modified")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset all shortcuts" }),
    ).toBeDisabled();

    const search = screen.getByRole("searchbox", { name: "Search shortcuts" });
    await user.type(search, "counter");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(row("Increment shortcut counter")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "⌘J");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(row("Toggle channel terminal")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "command ,");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(row("Open Settings")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText("No matching shortcuts.")).toBeInTheDocument();
    await user.clear(search);

    act(() => h.setActive("buzz.terminal", false));
    expect(
      screen.queryByRole("heading", { name: "Terminal" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(4);
    act(() => h.setActive("buzz.terminal", true));
    expect(row("Toggle channel terminal")).toBeInTheDocument();
  } finally {
    await h.dispose();
  }
});

it("captures a chord, refuses conflicts and bare keys, applies overrides to the dispatcher, and resets", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    const title = "Increment shortcut counter";
    expect(within(row(title)).getByText("Control Shift K")).toBeInTheDocument();
    await user.click(change(title));
    const input = capture(title);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Press a shortcut…");
    expect(input).toHaveAttribute("data-state", "listening");
    expect(input).toHaveAttribute("data-design-pass", "pending");
    expect(
      screen.getByRole("button", { name: `Cancel changing ${title}` }),
    ).toBeInTheDocument();
    // IME, bare modifiers and unmodified keys never become bindings.
    fireEvent.keyDown(input, { key: "k", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: "k", ctrlKey: true, keyCode: 229 });
    fireEvent.keyDown(input, { key: "Control", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Shift", shiftKey: true });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(capture(title)).toBe(input);
    fireEvent.keyDown(input, { key: "k", shiftKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Include Control or Alt so ordinary typing keeps working.",
    );
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The Windows/Command key isn’t used for shortcuts on this device.",
    );
    // Conflicts are reported by title and owner; nothing is saved or fired.
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl+K is already used by Search Buzz (Buzz).",
    );
    expect(screen.getByRole("alert")).toHaveClass("text-danger");
    expect(input).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("alert").id,
    );
    fireEvent.keyDown(input, { key: "j", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl+J is already used by Toggle channel terminal (Terminal).",
    );
    expect(h.runs.search).not.toHaveBeenCalled();
    expect(h.runs.terminal).not.toHaveBeenCalled();
    expect(h.bindings.snapshot().overrides).toEqual({});
    expect(capture(title)).toBe(input);

    await user.keyboard("{Control>}{Shift>}u{/Shift}{/Control}");
    expect(screen.queryByRole("textbox", { name: /New shortcut/ })).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(row(title)).getByText("Modified")).toBeInTheDocument();
    expect(within(row(title)).getByText("Control Shift U")).toBeInTheDocument();
    expect(change(title)).toHaveFocus();
    expect(h.bindings.snapshot().overrides).toEqual({
      "example.counter/increment": { key: "u", mod: true, shift: true },
    });
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBe(
      JSON.stringify({
        "example.counter/increment": { key: "u", mod: true, shift: true },
      }),
    );
    expect(h.press("k", { shiftKey: true })).toBe(true);
    expect(h.runs.increment).not.toHaveBeenCalled();
    expect(h.press("u", { shiftKey: true })).toBe(false);
    expect(h.runs.increment).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: `Reset shortcut for ${title}` }),
    );
    expect(within(row(title)).queryByText("Modified")).toBeNull();
    expect(h.bindings.resolve("example.counter/increment")).toBeUndefined();
    h.press("k", { shiftKey: true });
    expect(h.runs.increment).toHaveBeenCalledTimes(2);

    // Escape and blur cancel without saving; focus returns to the row action.
    await user.click(change("Open Settings"));
    fireEvent.keyDown(capture("Open Settings"), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: /New shortcut/ })).toBeNull();
    expect(change("Open Settings")).toHaveFocus();
    await user.click(change("Open Settings"));
    await user.click(document.body);
    expect(screen.queryByRole("textbox", { name: /New shortcut/ })).toBeNull();
    expect(h.bindings.snapshot().overrides).toEqual({});

    // Editor-local chords save with a warning; the freed chord becomes usable.
    await user.click(change("Open Settings"));
    fireEvent.keyDown(capture("Open Settings"), { key: "z", ctrlKey: true });
    const warning = within(row("Open Settings")).getByRole("alert");
    expect(warning).toHaveTextContent("message editor handles Ctrl+Z");
    expect(warning).toHaveClass("text-warning");
    expect(h.bindings.resolve("settings")).toEqual({ key: "z", mod: true });
    await user.click(change("Toggle channel terminal"));
    fireEvent.keyDown(capture("Toggle channel terminal"), {
      key: ",",
      ctrlKey: true,
    });
    expect(
      within(row("Toggle channel terminal")).getByText("Modified"),
    ).toBeInTheDocument();
    h.press(",");
    expect(h.runs.terminal).toHaveBeenCalledTimes(1);
    expect(h.runs.settings).not.toHaveBeenCalled();
    // Choosing a shortcut's own default clears its override instead.
    await user.click(change("Toggle channel terminal"));
    fireEvent.keyDown(capture("Toggle channel terminal"), {
      key: "j",
      ctrlKey: true,
    });
    expect(within(row("Toggle channel terminal")).queryByText("Modified")).toBe(
      null,
    );
    expect(h.bindings.resolve("buzz.terminal/toggle")).toBeUndefined();

    // Rebinding an alias set replaces the whole set; reset restores it.
    await user.click(change("Increase text size"));
    fireEvent.keyDown(capture("Increase text size"), {
      key: "=",
      ctrlKey: true,
      altKey: true,
    });
    expect(
      within(row("Increase text size")).getByText("Control Alt ="),
    ).toBeInTheDocument();
    h.press("=");
    h.press("+", { shiftKey: true });
    expect(h.runs.grow).not.toHaveBeenCalled();
    h.press("=", { altKey: true });
    expect(h.runs.grow).toHaveBeenCalledTimes(1);
    const resetAll = screen.getByRole("button", {
      name: "Reset all shortcuts",
    });
    expect(resetAll).toBeEnabled();
    await user.click(resetAll);
    expect(screen.queryByText("Modified")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(resetAll).toBeDisabled();
    expect(h.bindings.snapshot().overrides).toEqual({});
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBeNull();
    h.press("+", { shiftKey: true });
    expect(h.runs.grow).toHaveBeenCalledTimes(2);
    h.press(",");
    expect(h.runs.settings).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});

it("keeps a change active when saving fails and offers a retry", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    await user.click(change("Toggle channel terminal"));
    fireEvent.keyDown(capture("Toggle channel terminal"), {
      key: "u",
      ctrlKey: true,
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("could not be saved on this device");
    expect(
      within(row("Toggle channel terminal")).getByText("Modified"),
    ).toBeInTheDocument();
    h.press("u");
    expect(h.runs.terminal).toHaveBeenCalledTimes(1);
    write.mockRestore();
    await user.click(
      within(alert).getByRole("button", { name: "Retry saving shortcuts" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBe(
      JSON.stringify({ "buzz.terminal/toggle": { key: "u", mod: true } }),
    );
  } finally {
    await h.dispose();
  }
});
