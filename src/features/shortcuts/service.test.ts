import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { ShortcutsService } from "./service";
import { createShortcutBindings } from "./preferences";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import type { KeyBinding, Shortcut } from "./bindings";

function browser(apple = true) {
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  let modal = false;
  const host = {
    navigator: { platform: apple ? "MacIntel" : "Linux x86_64" },
    document: {
      querySelector: () => (modal ? {} : null),
      querySelectorAll: () =>
        modal ? [{ closest: () => null, matches: () => false }] : [],
    },
    addEventListener: (type: string, fn: (event: KeyboardEvent) => void) =>
      listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
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
      listeners.get("keydown")?.(event);
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
  reloadable: true,
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

it.each([true, false])(
  "matches Control beside Command only on Apple platforms (Apple=%s)",
  (apple) => {
    const b = browser(apple),
      ctx = new Context();
    ctx.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const service = new ShortcutsService(ctx, b.host),
      run = vi.fn();
    service.registerHost({
      ...shortcut(run),
      binding: { key: "a", mod: true, ctrl: true },
    });
    for (const init of [
      { ctrlKey: true, metaKey: true },
      { ctrlKey: !apple, metaKey: apple },
      { ctrlKey: true, metaKey: false },
    ])
      b.key("a", init);
    expect(run).toHaveBeenCalledTimes(apple ? 1 : 0);
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

it("normalizes presentation order without changing the registered shortcut contract", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new ShortcutsService(root, undefined);
  try {
    const owner = root.extend({
      pluginOwner: { id: "ordered", revision: "one" },
    });
    await owner.plugin((ctx) => {
      ctx.shortcuts.register({
        ...shortcut(),
        id: "default-order",
      });
      ctx.shortcuts.register({
        ...shortcut(),
        id: "custom-order",
        order: -5,
      });
      ctx.shortcuts.register({
        ...shortcut(),
        id: "non-finite-order",
        order: Number.POSITIVE_INFINITY,
      });
    });
    expect(service.snapshot().map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "default-order", order: 0 },
      { id: "custom-order", order: -5 },
      { id: "non-finite-order", order: 0 },
    ]);
    await owner.fiber.dispose();
  } finally {
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

it("accepts the logical Space key but not an empty binding", async () => {
  const b = browser(),
    root = new Context(),
    run = vi.fn();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new ShortcutsService(root, b.host);
  try {
    expect(() =>
      service.registerHost({ ...shortcut(), binding: { key: "" } }),
    ).toThrow();
    service.registerHost({
      ...shortcut(run),
      binding: { key: " ", mod: true },
    });
    expect(b.key(" ").defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(b.key("Space").defaultPrevented).toBe(false);
  } finally {
    await root.fiber.dispose();
  }
});

it("resolves user overrides at match time for plugin and host bindings", async () => {
  const b = browser(),
    root = new Context(),
    calls: string[] = [];
  const overrides = new Map<string, readonly KeyBinding[]>();
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
  const service = new ShortcutsService(root, b.host, {
    resolve: (key) => overrides.get(key),
  });
  try {
    runtime.reconcile([plugin("a")]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(1));
    // No override: the registered default applies.
    b.key();
    expect(calls).toEqual(["a:one"]);
    overrides.set("a/action", [{ key: "p", mod: true, shift: true }]);
    expect(b.key().defaultPrevented).toBe(false);
    expect(b.key("p", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(calls).toEqual(["a:one", "a:one"]);
    // The plugin never re-registers; the override follows the stable key
    // across disable, re-enable and replacement.
    runtime.reconcile([]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(0));
    expect(b.key("p", { shiftKey: true }).defaultPrevented).toBe(false);
    runtime.reconcile([plugin("a", "two")]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(1));
    b.key("p", { shiftKey: true });
    expect(calls.at(-1)).toBe("a:two");
    expect(service.snapshot()[0]?.binding).toEqual([{ key: "k", mod: true }]);
    // A host binding's overridden chord is the reserved one.
    const hostRun = vi.fn();
    const remove = service.registerHost({
      ...shortcut(hostRun),
      id: "host-action",
      binding: { key: "h", mod: true },
    });
    overrides.set("host-action", [{ key: "p", mod: true, shift: true }]);
    b.key("p", { shiftKey: true });
    expect(hostRun).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(b.key("h").defaultPrevented).toBe(false);
    overrides.delete("host-action");
    b.key("h");
    expect(hostRun).toHaveBeenCalledTimes(2);
    b.key("p", { shiftKey: true });
    expect(calls).toHaveLength(4);
    remove();
  } finally {
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it("keeps dispatching when a host id shadows an Object.prototype name or a resolver misbehaves", async () => {
  const b = browser(),
    root = new Context(),
    run = vi.fn();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const store = createShortcutBindings(undefined);
  const service = new ShortcutsService(root, b.host, store);
  try {
    // "constructor" passes the host id rule; the lookup must yield a binding
    // list or nothing, never Object.prototype.constructor.
    service.registerHost({ ...shortcut(run), id: "constructor" });
    expect(store.resolve("constructor")).toBeUndefined();
    expect(b.key().defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    store.set("constructor", { key: "p", mod: true });
    expect(store.resolve("constructor")).toEqual([{ key: "p", mod: true }]);
    expect(b.key().defaultPrevented).toBe(false);
    expect(b.key("p").defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    store.dispose();
    await root.fiber.dispose();
  }
  // Anything that is not a nonempty binding list means the registered default.
  for (const result of [
    Object,
    "⌘P",
    { key: "p", mod: true },
    [],
    [{ key: 5 }],
    [{ key: "p", mod: "yes" }],
    null,
  ]) {
    const ctx = new Context(),
      fallback = vi.fn();
    ctx.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const broken = new ShortcutsService(ctx, b.host, {
      resolve: () => result as never,
    });
    try {
      broken.registerHost(shortcut(fallback));
      expect(b.key("p").defaultPrevented).toBe(false);
      expect(b.key().defaultPrevented).toBe(true);
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.fiber.dispose();
    }
  }
  expect(b.listeners.size).toBe(0);
});

it("exposes host bindings to the host with change notifications", async () => {
  const b = browser(),
    ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new ShortcutsService(ctx, b.host);
  const listener = vi.fn();
  const stop = service.hostSubscribe(listener);
  expect(service.hostSnapshot()).toEqual([]);
  const remove = service.registerHost(shortcut());
  expect(listener).toHaveBeenCalledTimes(1);
  const registered = service.hostSnapshot();
  expect(registered.map((entry) => entry.id)).toEqual(["action"]);
  expect(registered[0]?.binding).toEqual([{ key: "k", mod: true }]);
  expect(service.snapshot()).toEqual([]);
  remove();
  remove();
  expect(listener).toHaveBeenCalledTimes(2);
  expect(service.hostSnapshot()).toEqual([]);
  expect(service.hostSnapshot()).not.toBe(registered);
  stop();
  service.registerHost(shortcut());
  expect(listener).toHaveBeenCalledTimes(2);
  expect(service.hostSnapshot()).toHaveLength(1);
  await ctx.fiber.dispose();
  expect(service.hostSnapshot()).toEqual([]);
});

const dockChord: KeyBinding = { key: "d", mod: true };
const focusChord: KeyBinding = { key: "l", mod: true };
const homeChord: KeyBinding = { key: "h", mod: true };

/** A dispatcher on an Apple platform whose native menu may own chords. */
function nativeRig(
  native: readonly KeyBinding[],
  saved: Record<string, readonly KeyBinding[]> = {},
) {
  const b = browser(true),
    root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new ShortcutsService(
    root,
    b.host,
    { resolve: (key) => saved[key] },
    native,
  );
  const host = (id: string, binding: KeyBinding, order = 0) => {
    const run = vi.fn();
    service.registerHost({
      id,
      title: id,
      binding,
      order,
      run,
    });
    return run;
  };
  return { b, root, service, host };
}

it.each([
  ["a host shortcut bound to it", "host"],
  ["a plugin contribution bound to it", "plugin"],
  ["an override that moves a host shortcut onto it", "override"],
] as const)(
  "leaves ⌘D to the native menu, with %s, and runs it when nothing is native",
  async (_name, subject) => {
    for (const native of [[dockChord], []]) {
      const rig = nativeRig(
        native,
        subject === "override" ? { subject: [dockChord] } : {},
      );
      const run = vi.fn();
      try {
        if (subject === "plugin")
          await rig.root
            .extend({ pluginOwner: { id: "a", revision: "one" } })
            .plugin((ctx) => {
              ctx.shortcuts.register({ ...shortcut(run), binding: dockChord });
            })
            .await();
        else
          rig.service.registerHost({
            ...shortcut(run),
            id: "subject",
            binding: subject === "host" ? dockChord : homeChord,
          });
        const event = rig.b.key("d");
        expect(run).toHaveBeenCalledTimes(native.length ? 0 : 1);
        expect(event.defaultPrevented).toBe(native.length === 0);
        // Native does not stop other chords from reaching their actions.
        if (subject !== "plugin") {
          const other = rig.host("other", focusChord);
          rig.b.key("l");
          expect(other).toHaveBeenCalledTimes(1);
        }
      } finally {
        await rig.root.fiber.dispose();
      }
    }
  },
);

it("upgrade profile: an override that put ⌘D on a focus action falls back to its default, and ⌘D runs nothing", async () => {
  const rig = nativeRig([dockChord], { "focus-composer": [dockChord] });
  try {
    const run = rig.host("focus-composer", focusChord, 10);
    const other = rig.host("open-home", homeChord, 20);
    expect(rig.b.key("d").defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(rig.b.key("l").defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  } finally {
    await rig.root.fiber.dispose();
  }
});

it("upgrade profile: a masked action stays unbound when another action's override holds its default", async () => {
  const saved = {
    "focus-composer": [dockChord],
    "open-home": [focusChord],
  };
  const rig = nativeRig([dockChord], saved);
  try {
    const focus = rig.host("focus-composer", focusChord, 10);
    const home = rig.host("open-home", homeChord, 20);
    expect(rig.b.key("l").defaultPrevented).toBe(true);
    expect(home).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
    expect(rig.b.key("d").defaultPrevented).toBe(false);
    // Home's old default is free, since it was overridden away from it.
    expect(rig.b.key("h").defaultPrevented).toBe(false);
    expect([focus, home].map((run) => run.mock.calls.length)).toEqual([0, 1]);
    // Dispatch resolves without writing anything back.
    expect(saved).toEqual({
      "focus-composer": [dockChord],
      "open-home": [focusChord],
    });
  } finally {
    await rig.root.fiber.dispose();
  }
});

it("keeps a masked action's default free for the first of two masked actions and unbinds the second", async () => {
  const rig = nativeRig([dockChord], {
    first: [dockChord],
    second: [dockChord],
  });
  try {
    const first = rig.host("first", focusChord, 10);
    const second = rig.host("second", focusChord, 20);
    rig.b.key("l");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  } finally {
    await rig.root.fiber.dispose();
  }
});

it("upgrade profile off macOS: a saved Ctrl+D keeps its action and the new dock default is unbound", async () => {
  const b = browser(false),
    root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(undefined);
  bindings.set("focus-composer", dockChord);
  const service = new ShortcutsService(root, b.host, bindings, []);
  try {
    const dock = vi.fn();
    const focus = vi.fn();
    service.registerHost(
      {
        id: "go-to-dock",
        title: "Go to dock",
        binding: dockChord,
        order: 72,
        run: dock,
      },
      { yields: true },
    );
    service.registerHost({
      id: "focus-composer",
      title: "Focus message box",
      binding: focusChord,
      order: 10,
      run: focus,
    });
    expect(service.resolved().get("go-to-dock")?.effective).toEqual([]);
    expect(b.key("d").defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(dock).not.toHaveBeenCalled();
    // Moving the saved shortcut off Ctrl+D gives the dock its default back.
    bindings.set("focus-composer", homeChord);
    expect(service.resolved().get("go-to-dock")?.effective).toEqual([
      dockChord,
    ]);
    b.key("d");
    expect(dock).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  } finally {
    await root.fiber.dispose();
    bindings.dispose();
  }
});

it("reset after a plugin took the freed chord: the host action answers to its default again", async () => {
  const b = browser(false),
    root = new Context();
  const plugged = vi.fn();
  const runtime = new PluginRuntime(root, async () => ({
    inject: ["shortcuts"],
    apply(ctx) {
      ctx.shortcuts.register(shortcut(plugged));
    },
  }));
  const bindings = createShortcutBindings(undefined);
  const service = new ShortcutsService(root, b.host, bindings, []);
  try {
    runtime.reconcile([plugin("a")]);
    await vi.waitFor(() => expect(service.snapshot()).toHaveLength(1));
    const focus = vi.fn();
    service.registerHost({
      id: "focus-composer",
      title: "Focus message box",
      binding: focusChord,
      order: 10,
      run: focus,
    });
    service.registerHost(
      {
        id: "go-to-dock",
        title: "Go to dock",
        binding: dockChord,
        order: 72,
        run: vi.fn(),
      },
      { yields: true },
    );
    // Move Focus message box off Ctrl+L, give Ctrl+L to the plugin, reset.
    bindings.set("focus-composer", homeChord);
    bindings.set("a/action", focusChord);
    bindings.set("focus-composer", null);
    expect(service.resolved().get("focus-composer")?.effective).toEqual([
      focusChord,
    ]);
    expect(service.resolved().get("a/action")?.effective).toEqual([focusChord]);
    // The host action keeps priority on the shared chord, as before.
    b.key("l");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(plugged).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
    await root.fiber.dispose();
    bindings.dispose();
  }
});
