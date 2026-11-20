// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editKeyPreference } from "./edit-key-preference";
import { sendKeyPreference } from "./send-key-preference";
import { smoothWheelPreference } from "./smooth-wheel-preference";

const preferences = [
  ["buzz-edit-with-up-arrow.v1", editKeyPreference, false],
  ["buzz-send-with-mod-enter.v1", sendKeyPreference, false],
  ["buzz-smooth-mouse-wheel.v1", smoothWheelPreference, true],
] as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const [, preference] of preferences) preference.set(false);
  localStorage.clear();
});

describe.each(preferences)("%s", (key, preference, fallback) => {
  it("reads its default when storage is absent, invalid, or unavailable", () => {
    localStorage.clear();
    expect(preference.read()).toBe(fallback);
    localStorage.setItem(key, "unknown");
    expect(preference.read()).toBe(fallback);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(preference.read()).toBe(fallback);
  });

  it("updates mounted readers for local writes, other windows, and cleared storage", () => {
    const first = renderHook(preference.usePreference);
    const second = renderHook(preference.usePreference);
    act(() => {
      preference.set(true);
    });
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
    act(() => {
      localStorage.setItem(key, "off");
      window.dispatchEvent(new StorageEvent("storage", { key: key }));
    });
    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(false);
    act(() => {
      preference.set(true);
    });
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(first.result.current).toBe(fallback);
    expect(second.result.current).toBe(fallback);
  });

  it("persists choices and keeps failed writes active until retry", () => {
    expect(preference.set(true)).toBeNull();
    expect(localStorage.getItem(key)).toBe("on");
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("full");
      });
    expect(preference.set(false)).toMatch(/could not be saved/);
    expect(preference.read()).toBe(false);
    expect(localStorage.getItem(key)).toBe("on");
    storage.mockRestore();
    expect(preference.set(false)).toBeNull();
    expect(localStorage.getItem(key)).toBe("off");
    expect(preference.read()).toBe(false);
  });
});

it("isolates unsaved choices and their save errors, and ignores unrelated storage events", () => {
  const edit = renderHook(editKeyPreference.usePreference);
  const send = renderHook(sendKeyPreference.usePreference);
  const editError = renderHook(editKeyPreference.useSaveError);
  const sendError = renderHook(sendKeyPreference.useSaveError);
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new Error("full");
  });
  act(() => {
    editKeyPreference.set(true);
  });
  act(() => {
    sendKeyPreference.set(true);
  });
  expect(edit.result.current).toBe(true);
  expect(send.result.current).toBe(true);
  expect(editError.result.current).toMatch(/could not be saved/);
  expect(sendError.result.current).toBeNull();
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
  });
  expect(edit.result.current).toBe(true);
  expect(editError.result.current).toMatch(/could not be saved/);
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-send-with-mod-enter.v1" }),
    );
  });
  expect(edit.result.current).toBe(true);
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-edit-with-up-arrow.v1" }),
    );
  });
  expect(edit.result.current).toBe(false);
  expect(editError.result.current).toBeNull();
  expect(send.result.current).toBe(true);
});
