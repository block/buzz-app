// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setDiffLayout, useDiffLayout } from "./diff-layout";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
it("shares the layout between panels and restores it after remount", () => {
  const first = renderHook(useDiffLayout);
  const second = renderHook(useDiffLayout);
  expect(first.result.current).toBe("unified");
  act(() => setDiffLayout("split"));
  expect(first.result.current).toBe("split");
  expect(second.result.current).toBe("split");
  first.unmount();
  second.unmount();
  expect(renderHook(useDiffLayout).result.current).toBe("split");
});
it("accepts another window's choice and falls back for invalid or removed values", () => {
  act(() => setDiffLayout("split"));
  const panel = renderHook(useDiffLayout);
  const key = localStorage.key(0);
  if (!key) throw new Error("No saved layout");
  act(() => {
    localStorage.setItem(key, "invalid");
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  expect(panel.result.current).toBe("unified");
  act(() => setDiffLayout("split"));
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(panel.result.current).toBe("unified");
});
it("keeps the saved layout when saving fails", () => {
  const panel = renderHook(useDiffLayout);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  expect(() => act(() => setDiffLayout("split"))).toThrow("Unavailable");
  expect(panel.result.current).toBe("unified");
});
it("reads safely when storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  expect(renderHook(useDiffLayout).result.current).toBe("unified");
});
