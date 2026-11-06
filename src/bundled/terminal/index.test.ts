// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement, StrictMode, useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { PanelsService } from "../../features/panels/service";
import {
  type ChannelDrawerOpening,
  useChannelPanels,
} from "../channels/useChannelPanels";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsCard } from "../../features/settings/service";
import { TERMINAL_FONT_KEY } from "./font-preference";
import { TERMINAL_PLACEMENT_KEY } from "./placement-preference";
import { apply } from "./index";
import { nativeBridge } from "./bridge";

vi.mock("./bridge", () => ({ nativeBridge: { available: false } }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  nativeBridge.available = false;
  vi.restoreAllMocks();
});

it("retains registered font drafts across navigation and clears them on Apply/reset", async () => {
  nativeBridge.available = true;
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  const card = ctx.settingsCards.register.mock.calls[0]?.[0] as SettingsCard;
  const open = () =>
    render(createElement(card.component, { active: () => true }));
  const family = () => screen.getByRole("textbox", { name: "Font family" });
  const size = () => screen.getByRole("spinbutton", { name: "Font size (px)" });
  let view = open();
  try {
    fireEvent.change(family(), { target: { value: "A,B" } });
    fireEvent.change(size(), { target: { value: "99" } });
    view.unmount();
    view = open();
    expect(family()).toHaveValue("A,B");
    expect(size()).toHaveValue(99);
    expect(family()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    view.unmount();
    view = open();
    expect(family()).toHaveValue("");
    expect(size()).toHaveValue(12);
    fireEvent.change(size(), { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    view.unmount();
    view = open();
    expect(size()).toHaveValue(16);
    act(() => {
      localStorage.setItem(
        TERMINAL_FONT_KEY,
        JSON.stringify({ family: null, size: 20 }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: TERMINAL_FONT_KEY,
          storageArea: localStorage,
        }),
      );
    });
    expect(size()).toHaveValue(20);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  } finally {
    view.unmount();
    await ctx.dispose();
  }
});

function host() {
  const panels = { register: vi.fn() };
  const shortcuts = { register: vi.fn() };
  const disposers: (() => unknown)[] = [];
  const effect = vi.fn((callback: () => () => unknown) => {
    disposers.push(callback());
  });
  const inject = vi.fn((_deps, callback) => {
    callback({ panels });
    const fiber = { dispose: vi.fn() };
    disposers.push(fiber.dispose);
    return fiber;
  });
  const relay = { snapshot: vi.fn() };
  const settingsCards = { register: vi.fn() };
  return {
    panels,
    shortcuts,
    effect,
    inject,
    relay,
    settingsCards,
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}
it("does not register a panel or shortcut without native terminal support", () => {
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  expect(ctx.panels.register).not.toHaveBeenCalled();
  expect(ctx.shortcuts.register).not.toHaveBeenCalled();
  expect(ctx.settingsCards.register).not.toHaveBeenCalled();
  expect(ctx.effect).not.toHaveBeenCalled();
});
it("retains the desktop panel, shortcut and session cleanup", async () => {
  nativeBridge.available = true;
  const subscribe = vi.spyOn(window, "addEventListener");
  const unsubscribe = vi.spyOn(window, "removeEventListener");
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  expect(ctx.panels.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "terminal",
      channelPlacement: "bottom",
      channelLauncher: expect.any(Function),
      component: expect.any(Function),
    }),
  );
  expect(ctx.shortcuts.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "toggle",
      binding: { key: "j", mod: true },
    }),
  );
  expect(ctx.effect).toHaveBeenCalledTimes(2);
  expect(ctx.inject).toHaveBeenCalledWith(["panels"], expect.any(Function));
  expect(ctx.settingsCards.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "settings",
      title: "Terminal",
      group: "Plugins",
      component: expect.any(Function),
    }),
  );
  const storageListeners = subscribe.mock.calls.filter(
    ([event]) => event === "storage",
  );
  expect(storageListeners).toHaveLength(2);
  await ctx.dispose();
  for (const [, listener] of storageListeners)
    expect(unsubscribe).toHaveBeenCalledWith("storage", listener);
  expect(ctx.inject.mock.results[0]?.value.dispose).toHaveBeenCalledOnce();
});

it("replaces its child panel scope only for a different placement", async () => {
  nativeBridge.available = true;
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  const change = (value: string) => {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, value);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: TERMINAL_PLACEMENT_KEY,
        storageArea: localStorage,
      }),
    );
  };
  change("side");
  expect(ctx.inject.mock.results[0]?.value.dispose).toHaveBeenCalledOnce();
  expect(ctx.panels.register).toHaveBeenLastCalledWith(
    expect.objectContaining({ channelPlacement: "side" }),
  );
  change("side");
  expect(ctx.panels.register).toHaveBeenCalledTimes(2);
  change("tab");
  expect(ctx.panels.register).toHaveBeenLastCalledWith(
    expect.objectContaining({ channelPlacement: "tab" }),
  );
  expect(ctx.shortcuts.register).toHaveBeenCalledOnce();
  expect(ctx.settingsCards.register).toHaveBeenCalledOnce();
  await ctx.dispose();
});

it.each([false, true])(
  "reopens an open panel through real Cordis and host cleanup without opening a closed one (retained side: %s)",
  async (retained) => {
    nativeBridge.available = true;
    const ctx = new Context();
    ctx.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const panels = new PanelsService(ctx);
    ctx.provide("relay", { snapshot: vi.fn() } as unknown as typeof ctx.relay);
    ctx.provide("shortcuts", {
      register: vi.fn(),
    } as unknown as typeof ctx.shortcuts);
    ctx.provide("settingsCards", {
      register: vi.fn(),
    } as unknown as typeof ctx.settingsCards);
    await ctx
      .extend({ pluginOwner: { id: "buzz.terminal", revision: "test" } })
      .plugin((scope) => apply(scope))
      .await();
    const context = {
      scope: "scope",
      viewer: "viewer",
      channelId: "alpha",
      channelName: "Alpha",
      relayUrl: "wss://example.test",
    };
    const toggles = vi.fn();
    function Harness() {
      const [opening, set] = useState<ChannelDrawerOpening>();
      // Only mount the launcher: the host still owns the opening's lifecycle.
      return useChannelPanels(
        panels,
        context,
        toggles,
        undefined,
        undefined,
        undefined,
        retained ? { opening, set } : undefined,
      ).launchers;
    }
    const view = render(
      createElement(StrictMode, null, createElement(Harness)),
    );
    const launcher = () =>
      screen.getByRole("button", { name: "Toggle channel terminal" });
    const change = async (value: string) => {
      await act(async () => {
        localStorage.setItem(TERMINAL_PLACEMENT_KEY, value);
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: TERMINAL_PLACEMENT_KEY,
            storageArea: localStorage,
          }),
        );
      });
    };
    try {
      await change("side");
      expect(launcher()).toHaveAttribute("aria-expanded", "false");
      expect(toggles).not.toHaveBeenCalled();
      fireEvent.click(launcher());
      expect(launcher()).toHaveAttribute("aria-expanded", "true");
      await change("bottom");
      expect(launcher()).toHaveAttribute("aria-expanded", "true");
      expect(toggles).toHaveBeenCalledTimes(2);
      await change("side");
      expect(launcher()).toHaveAttribute("aria-expanded", "true");
      expect(toggles).toHaveBeenCalledTimes(3);
      fireEvent.click(launcher());
      await change("bottom");
      expect(launcher()).toHaveAttribute("aria-expanded", "false");
      expect(toggles).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      await ctx.fiber.dispose();
    }
  },
);
