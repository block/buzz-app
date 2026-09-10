import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { ShortcutsService } from "./service";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import type { Shortcut } from "./bindings";

function browser(apple = true) {
  const listeners = new Set<(event: KeyboardEvent) => void>();
  let modal = false;
  const host = {
    navigator: { platform: apple ? "MacIntel" : "Linux x86_64" },
    document: { querySelector: () => (modal ? {} : null) },
    addEventListener: (_: string, fn: (event: KeyboardEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_: string, fn: (event: KeyboardEvent) => void) =>
      listeners.delete(fn),
  } as unknown as Window;
  return {
    host,
    listeners,
    modal(value: boolean) {
      modal = value;
    },
    key(key = "k", init: Partial<KeyboardEvent> = {}, path: unknown[] = []) {
      const event = {
        key,
        metaKey: apple,
        ctrlKey: !apple,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        repeat: false,
        isComposing: false,
        keyCode: 0,
        getModifierState: () => false,
        composedPath: () => path,
        preventDefault() {
          Object.defineProperty(this, "defaultPrevented", { value: true });
        },
        ...init,
      } as KeyboardEvent;
      for (const dispatch of listeners) dispatch(event);
      return event;
    },
  };
}
const shortcut = (run: Shortcut["run"] = vi.fn()): Shortcut => ({
  id: "action",
  title: "Action",
  binding: { key: "k", mod: true },
  run,
});
const plugin = (id: string, revision = "one"): PluginInfo => ({
  manifest: { id, name: id, apiVersion: 1 },
  enabled: true,
  source: "external",
  revision,
  previous: null,
  error: null,
});

it.each([true, false])(
  "matches platform Mod and exact modifiers; protects local handlers, IME and focus (Apple=%s)",
  async (apple) => {
    const b = browser(apple),
      ctx = new Context();
    ctx.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const service = new ShortcutsService(ctx, b.host),
      run = vi.fn();
    service.registerHost(shortcut(run));
    expect(b.key().defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    for (const init of [
      { altKey: true },
      { shiftKey: true },
      { ctrlKey: true, metaKey: true },
      { ctrlKey: false, metaKey: false },
      { isComposing: true },
      { keyCode: 229 },
      { defaultPrevented: true },
      { getModifierState: () => true },
    ])
      b.key("k", init);
    for (const target of [
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { isContentEditable: true },
      { getAttribute: () => "textbox" },
    ]) {
      expect(
        b.key("k", {}, [target, { tagName: "SHADOW-HOST" }]).defaultPrevented,
      ).toBe(false);
    }
    b.modal(true);
    expect(b.key().defaultPrevented).toBe(false);
    b.modal(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(b.key("k", { repeat: true }).defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await ctx.fiber.dispose();
    expect(b.listeners.size).toBe(0);
    b.key();
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it("real plugin activation, stable conflicts, host reservations, replacement and disposal", async () => {
  const b = browser(),
    root = new Context(),
    calls: string[] = [];
  const runtime = new PluginRuntime(root, async (info) => ({
    inject: ["shortcuts"],
    apply(ctx) {
      ctx.shortcuts.register(
        shortcut(() => {
          calls.push(`${info.manifest.id}:${info.revision}`);
        }),
      );
    },
  }));
  const service = new ShortcutsService(root, b.host);
  try {
    // Reverse activation order deliberately; namespaced ID decides conflicts.
    runtime.reconcile([plugin("z")]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(1));
    runtime.reconcile([plugin("z"), plugin("a")]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(2));
    b.key();
    expect(calls).toEqual(["a:one"]);
    const remove = service.registerHost({
      ...shortcut(() => {
        calls.push("host");
      }),
      when: () => false,
    });
    expect(b.key().defaultPrevented).toBe(false);
    expect(calls).toHaveLength(1);
    remove();
    runtime.reconcile([plugin("z")]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(1));
    b.key();
    expect(calls.at(-1)).toBe("z:one");
    runtime.reconcile([plugin("z"), plugin("a", "two")]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(2));
    b.key();
    expect(calls.at(-1)).toBe("a:two");
    runtime.reconcile([plugin("z"), plugin("a", "three")]);
    await vi.waitFor(() =>
      expect(service.snapshot().find((s) => s.pluginId === "a")?.revision).toBe(
        "three",
      ),
    );
    b.key();
    expect(calls.at(-1)).toBe("a:three");
    const host = service.registerHost(
      shortcut(() => {
        calls.push("host");
      }),
    );
    b.key();
    expect(calls.at(-1)).toBe("host");
    host();
    await runtime.dispose();
    expect(service.snapshot()).toHaveLength(0);
    expect(b.key().defaultPrevented).toBe(false);
  } finally {
    await runtime.dispose();
    await root.fiber.dispose();
  }
  expect(b.listeners.size).toBe(0);
});

it("hides bindings before async apply finishes and after failed activation", async () => {
  const b = browser(),
    root = new Context(),
    run = vi.fn();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registered = vi.fn();
  const runtime = new PluginRuntime(root, async () => ({
    inject: ["shortcuts"],
    async apply(ctx) {
      ctx.shortcuts.register(shortcut(run));
      registered();
      await ready;
      throw new Error("failed apply");
    },
  }));
  const service = new ShortcutsService(root, b.host);
  runtime.reconcile([plugin("a")]);
  try {
    await vi.waitFor(() => expect(registered).toHaveBeenCalled());
    expect(service.snapshot()).toHaveLength(0);
    b.key();
    expect(run).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(runtime.snapshot().a?.status).toBe("failed"));
    b.key();
    expect(run).not.toHaveBeenCalled();
  } finally {
    release();
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it("validates and copies bindings, keeps owner checks, and contains async handler failures", async () => {
  const b = browser(),
    root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new ShortcutsService(root, b.host),
    run = vi.fn();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => service.register(shortcut())).toThrow("installed plugin");
    for (const value of [
      null,
      { ...shortcut(), binding: [] },
      { ...shortcut(), binding: { key: "" } },
      { ...shortcut(), binding: { key: "k", mod: 1 } },
      { ...shortcut(), run: null },
    ])
      expect(() => service.registerHost(value as never)).toThrow();
    const binding = { key: "k", mod: true };
    const remove = service.registerHost({
      ...shortcut(run),
      binding,
      allowInEditable: true,
      allowInModal: true,
      repeat: true,
    });
    binding.key = "x";
    b.modal(true);
    b.key("k", { repeat: true }, [{ tagName: "INPUT" }]);
    expect(run).toHaveBeenCalledOnce();
    expect(() => service.registerHost(shortcut())).toThrow(
      "already registered",
    );
    remove();
    service.registerHost(
      shortcut(async () => {
        throw new Error("rejected");
      }),
    );
    b.modal(false);
    b.key();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(
      "Shortcut failed: action",
      expect.any(Error),
    );
  } finally {
    error.mockRestore();
    await root.fiber.dispose();
  }
});
