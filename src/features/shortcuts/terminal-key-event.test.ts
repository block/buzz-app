// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { ShortcutsService } from "./service";
import { createShortcutBindings } from "./preferences";
import { forwardTerminalKey } from "./terminal-key-event";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("hands the original editable event to live dispatch exactly once, respecting guards and disposal", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(ctx, window, bindings);
  const run = vi.fn();
  let available = true;
  const registration = {
    id: "toggle",
    title: "Terminal",
    binding: { key: "j", mod: true },
    run,
    when: () => available,
  };
  let unregister = shortcuts.registerHost(registration);
  const input = document.createElement("textarea");
  document.body.append(input);
  input.addEventListener("keydown", (event) =>
    forwardTerminalKey(window, event),
  );
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const key = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "u",
      metaKey: apple,
      ctrlKey: !apple,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    input.dispatchEvent(event);
    return event;
  };
  try {
    bindings.set("toggle", { key: "u", mod: true });
    expect(key().defaultPrevented).toBe(false); // Original textarea path, not window.
    unregister();
    unregister = shortcuts.registerHost({
      ...registration,
      allowInEditable: true,
    });
    expect(key().defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1); // No second execution while bubbling.
    expect(key({ repeat: true }).defaultPrevented).toBe(true);
    available = false;
    expect(key().defaultPrevented).toBe(false);
    available = true;
    const modal = document.createElement("dialog");
    modal.setAttribute("open", "");
    document.body.append(modal);
    expect(key().defaultPrevented).toBe(false);
    modal.remove();
    for (const init of [
      { isComposing: true },
      { keyCode: 229 },
      { modifierAltGraph: true },
    ]) {
      expect(key(init).defaultPrevented).toBe(false);
    }
    const prevented = new KeyboardEvent("keydown", {
      key: "u",
      cancelable: true,
    });
    prevented.preventDefault();
    expect(forwardTerminalKey(window, prevented)).toBe(false);
    for (const type of ["keyup", "keypress"]) {
      expect(
        forwardTerminalKey(
          window,
          new KeyboardEvent(type, { key: "u", ctrlKey: true }),
        ),
      ).toBe(true);
    }
    expect(run).toHaveBeenCalledTimes(1);
    bindings.reset();
    expect(key().defaultPrevented).toBe(false);
    expect(key({ key: "j" }).defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    await ctx.fiber.dispose();
    expect(key({ key: "j" }).defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    unregister();
    bindings.dispose();
    await ctx.fiber.dispose();
  }
});
