import { afterEach, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(), invoke: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it.each([
  [false, "MacIntel", false],
  [true, "Win32", false],
  [true, "MacIntel", true],
  [true, "Linux x86_64", true],
  [true, "", false],
])(
  "desktop=%s platform=%s exposes terminal=%s",
  async (desktop, platform, available) => {
    vi.mocked(isTauri).mockReturnValue(desktop);
    vi.stubGlobal("navigator", { platform });
    const { nativeBridge } = await import("./bridge");
    expect(nativeBridge.available).toBe(available);
  },
);
