// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  createShortcutBindings,
  parseOverrides,
  SHORTCUT_BINDINGS_KEY,
} from "./preferences";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("keeps well-formed entries and drops only malformed ones", () => {
  expect(
    parseOverrides({
      "example.counter/increment": { key: "u", mod: true, shift: true },
      settings: { key: ";", mod: true, alt: false, extra: "ignored" },
      empty: { key: "" },
      text: "not a binding",
      flags: { key: "k", mod: "yes" },
      "": { key: "k", mod: true },
    }),
  ).toEqual({
    "example.counter/increment": { key: "u", mod: true, shift: true },
    settings: { key: ";", mod: true, alt: false },
  });
  for (const raw of [null, [], "text", 42])
    expect(parseOverrides(raw)).toEqual({});
});

it("restores what it can, reports unreadable storage, and resolves at lookup time", () => {
  localStorage.setItem(
    SHORTCUT_BINDINGS_KEY,
    JSON.stringify({
      "example.counter/increment": { key: "u", mod: true, shift: true },
      broken: { key: 5 },
    }),
  );
  const bindings = createShortcutBindings(window);
  expect(bindings.snapshot()).toEqual({
    overrides: {
      "example.counter/increment": { key: "u", mod: true, shift: true },
    },
    error: null,
  });
  expect(bindings.resolve("example.counter/increment")).toEqual({
    key: "u",
    mod: true,
    shift: true,
  });
  expect(bindings.resolve("broken")).toBeUndefined();
  expect(bindings.resolve("missing")).toBeUndefined();
  bindings.dispose();
  localStorage.setItem(SHORTCUT_BINDINGS_KEY, "{not json");
  const unreadable = createShortcutBindings(window);
  expect(unreadable.snapshot().overrides).toEqual({});
  expect(unreadable.snapshot().error).toContain("could not be restored");
  unreadable.set("settings", { key: ";", mod: true });
  expect(unreadable.snapshot().error).toBeNull();
  expect(JSON.parse(localStorage.getItem(SHORTCUT_BINDINGS_KEY) ?? "")).toEqual(
    { settings: { key: ";", mod: true } },
  );
  unreadable.dispose();
});

it("applies changes in memory when saving fails, retries, and clears storage when empty", () => {
  const bindings = createShortcutBindings(window);
  const listener = vi.fn();
  bindings.subscribe(listener);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  bindings.set("settings", { key: ";", mod: true });
  expect(bindings.resolve("settings")).toEqual({ key: ";", mod: true });
  expect(bindings.snapshot().error).toContain("could not be saved");
  expect(listener).toHaveBeenCalledTimes(1);
  write.mockRestore();
  bindings.retry();
  expect(bindings.snapshot().error).toBeNull();
  expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBe(
    JSON.stringify({ settings: { key: ";", mod: true } }),
  );
  bindings.set("other", { key: "o", alt: true });
  bindings.set("settings", null);
  expect(bindings.snapshot().overrides).toEqual({
    other: { key: "o", alt: true },
  });
  expect(() => bindings.set("bad", { key: "" })).toThrow("Invalid");
  bindings.reset();
  expect(bindings.snapshot().overrides).toEqual({});
  expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBeNull();
  bindings.dispose();
  bindings.set("settings", { key: ";", mod: true });
  expect(bindings.snapshot().overrides).toEqual({});
});

it("re-reads on same-origin storage events and ignores unrelated keys", () => {
  const bindings = createShortcutBindings(window);
  const listener = vi.fn();
  bindings.subscribe(listener);
  localStorage.setItem(
    SHORTCUT_BINDINGS_KEY,
    JSON.stringify({ settings: { key: ";", mod: true } }),
  );
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "buzz-appearance.v1",
      storageArea: localStorage,
    }),
  );
  expect(listener).not.toHaveBeenCalled();
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: SHORTCUT_BINDINGS_KEY,
      storageArea: localStorage,
    }),
  );
  expect(listener).toHaveBeenCalledTimes(1);
  expect(bindings.resolve("settings")).toEqual({ key: ";", mod: true });
  localStorage.clear();
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
  expect(bindings.snapshot().overrides).toEqual({});
  bindings.dispose();
  localStorage.setItem(
    SHORTCUT_BINDINGS_KEY,
    JSON.stringify({ settings: { key: ";", mod: true } }),
  );
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: SHORTCUT_BINDINGS_KEY,
      storageArea: localStorage,
    }),
  );
  expect(listener).toHaveBeenCalledTimes(2);
  expect(bindings.snapshot().overrides).toEqual({});
});
