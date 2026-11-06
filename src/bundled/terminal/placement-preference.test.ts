// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  createTerminalPlacementPreference,
  parsePlacement,
  TERMINAL_PLACEMENT_KEY,
} from "./placement-preference";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("restores each placement, defaults unknown values, and validates changes", () => {
  for (const value of [null, "side", "tab", "bottom", "unknown"]) {
    if (value === null) localStorage.removeItem(TERMINAL_PLACEMENT_KEY);
    else localStorage.setItem(TERMINAL_PLACEMENT_KEY, value);
    const store = createTerminalPlacementPreference();
    expect(store.snapshot()).toEqual({
      placement: value === "side" || value === "tab" ? value : "bottom",
      error: null,
    });
    store.dispose();
  }
  for (const value of [null, 1, "", "SIDE", " side "])
    expect(parsePlacement(value)).toBeNull();
  const store = createTerminalPlacementPreference();
  expect(() => store.set("invalid" as "side")).toThrow(
    "Invalid terminal placement",
  );
  expect(store.snapshot().placement).toBe("bottom");
  store.dispose();
});

it("saves a choice and removes the key on bottom or reset", () => {
  const store = createTerminalPlacementPreference();
  store.set("side");
  expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe("side");
  store.set("bottom");
  expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBeNull();
  store.set("tab");
  store.reset();
  expect(store.snapshot()).toEqual({ placement: "bottom", error: null });
  expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBeNull();
  store.dispose();
});

it("retries a failed restore without deleting the unread choice", () => {
  localStorage.setItem(TERMINAL_PLACEMENT_KEY, "side");
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  const store = createTerminalPlacementPreference();
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  expect(store.snapshot().error).toContain("could not be restored");
  store.retry();
  expect(remove).not.toHaveBeenCalled();
  read.mockRestore();
  store.retry();
  expect(store.snapshot()).toEqual({ placement: "side", error: null });
  store.dispose();
});

it("applies failed writes and resets in memory, and retries persistence", () => {
  const store = createTerminalPlacementPreference();
  const changed = vi.fn();
  const unsubscribe = store.subscribe(changed);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  store.set("tab");
  expect(store.snapshot().placement).toBe("tab");
  expect(store.snapshot().error).toContain("could not be saved");
  expect(changed).toHaveBeenCalledOnce();
  write.mockRestore();
  store.retry();
  expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe("tab");
  expect(store.snapshot().error).toBeNull();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  store.reset();
  expect(store.snapshot().placement).toBe("bottom");
  expect(store.snapshot().error).toContain("may return after restarting");
  remove.mockRestore();
  store.retry();
  expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBeNull();
  expect(store.snapshot().error).toBeNull();
  unsubscribe();
  changed.mockClear();
  store.set("side");
  expect(changed).not.toHaveBeenCalled();
  store.dispose();
});

it("re-reads current storage, ignores unrelated events, and disposes listeners", () => {
  const store = createTerminalPlacementPreference();
  const changed = vi.fn();
  store.subscribe(changed);
  const event = (key: string | null, storageArea = localStorage) =>
    window.dispatchEvent(
      new StorageEvent("storage", { key, storageArea, newValue: "stale" }),
    );
  localStorage.setItem(TERMINAL_PLACEMENT_KEY, "tab");
  event("other");
  event(TERMINAL_PLACEMENT_KEY, sessionStorage);
  expect(changed).not.toHaveBeenCalled();
  event(TERMINAL_PLACEMENT_KEY);
  expect(store.snapshot().placement).toBe("tab");
  localStorage.clear();
  event(null);
  expect(store.snapshot().placement).toBe("bottom");
  store.dispose();
  store.set("side");
  store.reset();
  store.retry();
  store.subscribe(changed);
  event(TERMINAL_PLACEMENT_KEY);
  expect(changed).toHaveBeenCalledTimes(2);
});
