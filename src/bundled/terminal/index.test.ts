// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";
import { nativeBridge } from "./bridge";

vi.mock("./bridge", () => ({ nativeBridge: { available: false } }));
afterEach(() => {
  nativeBridge.available = false;
  vi.restoreAllMocks();
});

function host() {
  const panels = { register: vi.fn() };
  const shortcuts = { register: vi.fn() };
  const effect = vi.fn();
  const relay = { snapshot: vi.fn() };
  const settingsCards = { register: vi.fn() };
  return { panels, shortcuts, effect, relay, settingsCards };
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
  expect(ctx.effect).toHaveBeenCalledTimes(1);
  expect(ctx.settingsCards.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "settings",
      title: "Terminal",
      group: "Plugins",
      component: expect.any(Function),
    }),
  );
  const storageListener = subscribe.mock.calls.find(
    ([event]) => event === "storage",
  )?.[1];
  expect(storageListener).toBeTypeOf("function");
  const effect = ctx.effect.mock.calls[0]?.[0];
  if (!effect) throw new Error("Missing plugin cleanup");
  await effect()();
  expect(unsubscribe).toHaveBeenCalledWith("storage", storageListener);
});
