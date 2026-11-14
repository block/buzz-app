// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  setThreadPlacementPreference,
  useThreadPlacementPreference,
} from "./thread-preferences";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setThreadPlacementPreference("side");
  localStorage.clear();
});

it("restores saved placement and follows an update from another window", () => {
  setThreadPlacementPreference("main");
  const first = renderHook(useThreadPlacementPreference);
  expect(first.result.current).toEqual({ placement: "main", unsaved: false });
  first.unmount();
  const restored = renderHook(useThreadPlacementPreference);
  expect(restored.result.current).toEqual({
    placement: "main",
    unsaved: false,
  });
  act(() => {
    localStorage.setItem("buzz-thread-placement.v1", "side");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-thread-placement.v1" }),
    );
  });
  expect(restored.result.current).toEqual({
    placement: "side",
    unsaved: false,
  });
});

it("retains an unsaved choice across remount and retries that same choice", () => {
  const first = renderHook(useThreadPlacementPreference);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("unavailable");
    });
  act(() => setThreadPlacementPreference("main"));
  expect(first.result.current).toEqual({ placement: "main", unsaved: true });
  first.unmount();
  const restored = renderHook(useThreadPlacementPreference);
  expect(restored.result.current).toEqual({ placement: "main", unsaved: true });
  write.mockRestore();
  act(() => setThreadPlacementPreference(restored.result.current.placement));
  expect(localStorage.getItem("buzz-thread-placement.v1")).toBe("main");
  expect(restored.result.current).toEqual({
    placement: "main",
    unsaved: false,
  });
});
