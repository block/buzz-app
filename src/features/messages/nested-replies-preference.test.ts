// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  expandNestedRepliesPreference,
  expandNestedRepliesSetting,
  setExpandNestedRepliesPreference,
  useExpandNestedRepliesPreference,
} from "./nested-replies-preference";

const key = "buzz-expand-nested-replies.v1";

afterEach(() => {
  vi.restoreAllMocks();
  setExpandNestedRepliesPreference(false);
  localStorage.clear();
});
it("defaults off, persists On, and treats unknown saved values as off", () => {
  localStorage.clear();
  expect(expandNestedRepliesPreference()).toBe(false);
  setExpandNestedRepliesPreference(true);
  expect(expandNestedRepliesPreference()).toBe(true);
  expect(localStorage.getItem(key)).toBe("on");
  localStorage.setItem(key, "unknown");
  expect(expandNestedRepliesPreference()).toBe(false);
});
it("retains the active choice when storage fails, reports it unsaved, and can retry", () => {
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("full");
    });
  const { result } = renderHook(() => useExpandNestedRepliesPreference());
  act(() => setExpandNestedRepliesPreference(true));
  expect(result.current).toEqual({ enabled: true, unsaved: true });
  expect(expandNestedRepliesSetting.read().unsaved).not.toBeNull();
  storage.mockRestore();
  act(() => setExpandNestedRepliesPreference(true));
  expect(result.current).toEqual({ enabled: true, unsaved: false });
  expect(localStorage.getItem(key)).toBe("on");
});
it("follows a change saved by another window", () => {
  const { result } = renderHook(() => useExpandNestedRepliesPreference());
  expect(result.current.enabled).toBe(false);
  act(() => {
    localStorage.setItem(key, "on");
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  expect(result.current.enabled).toBe(true);
});
