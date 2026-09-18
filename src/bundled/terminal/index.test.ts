import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";
import { nativeBridge } from "./bridge";

vi.mock("./bridge", () => ({ nativeBridge: { available: false } }));
afterEach(() => {
  nativeBridge.available = false;
});

function host() {
  const panels = { register: vi.fn() };
  const shortcuts = { register: vi.fn() };
  const effect = vi.fn();
  const relay = { snapshot: vi.fn() };
  return { panels, shortcuts, effect, relay };
}
it("does not register a panel or shortcut without native terminal support", () => {
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  expect(ctx.panels.register).not.toHaveBeenCalled();
  expect(ctx.shortcuts.register).not.toHaveBeenCalled();
  expect(ctx.effect).not.toHaveBeenCalled();
});
it("retains the desktop panel, shortcut and session cleanup", () => {
  nativeBridge.available = true;
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
});
