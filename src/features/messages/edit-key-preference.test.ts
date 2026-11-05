// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  editWithUpArrowPreference,
  setEditWithUpArrowPreference,
  useEditWithUpArrowPreference,
} from "./edit-key-preference";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setEditWithUpArrowPreference(false);
  localStorage.clear();
});

it("defaults off when storage is absent, invalid, or unavailable", () => {
  localStorage.clear();
  expect(editWithUpArrowPreference()).toBe(false);
  localStorage.setItem("buzz-edit-with-up-arrow.v1", "unknown");
  expect(editWithUpArrowPreference()).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(editWithUpArrowPreference()).toBe(false);
});

it("updates mounted readers for local writes, other windows, and cleared storage", () => {
  const first = renderHook(useEditWithUpArrowPreference);
  const second = renderHook(useEditWithUpArrowPreference);
  act(() => {
    setEditWithUpArrowPreference(true);
  });
  expect(first.result.current).toBe(true);
  expect(second.result.current).toBe(true);
  act(() => {
    localStorage.setItem("buzz-edit-with-up-arrow.v1", "off");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-edit-with-up-arrow.v1" }),
    );
  });
  expect(first.result.current).toBe(false);
  expect(second.result.current).toBe(false);
  act(() => {
    setEditWithUpArrowPreference(true);
  });
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(first.result.current).toBe(false);
  expect(second.result.current).toBe(false);
});
