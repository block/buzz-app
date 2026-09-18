import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import {
  APPEARANCE_KEY,
  FONT_SCALE_KEY,
  createAppearance,
  parseColorMode,
  parseFontScale,
} from "./service";

function browser(stored: string | null = null) {
  const values = new Map(stored === null ? [] : [[APPEARANCE_KEY, stored]]);
  const listeners = new Set<(event: StorageEvent) => void>();
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: vi.fn() },
  };
  const meta = { setAttribute: vi.fn() };
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
  const host = {
    localStorage: storage,
    document: { documentElement: root, querySelector: () => meta },
    getComputedStyle: () => ({
      getPropertyValue: () =>
        root.dataset.colorMode === "dark" ? " #11181d " : " #e7f0ef ",
    }),
    addEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.delete(fn),
  } as unknown as Window;
  return {
    host,
    root,
    meta,
    storage,
    listeners,
    values,
    change(
      key: string | null = APPEARANCE_KEY,
      storageArea: unknown = storage,
    ) {
      for (const fn of listeners) fn({ key, storageArea } as StorageEvent);
    },
  };
}

it.each([null, "", "system", "LIGHT", '{"mode":"dark"}', "light", "dark"])(
  "bootstrap and service agree for stored %j",
  (value) => {
    const b = browser(value);
    runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
      localStorage: b.storage,
      document: b.host.document,
    });
    expect(b.root.dataset.colorMode).toBe(parseColorMode(value));
    const app = createAppearance(b.host);
    expect(app.snapshot()).toEqual({
      mode: parseColorMode(value),
      error: null,
      fontScale: 1,
      fontError: null,
    });
    expect(b.root.dataset.colorMode).toBe(app.snapshot().mode);
    expect(b.meta.setAttribute).toHaveBeenLastCalledWith(
      "content",
      value === "dark" ? "#11181d" : "#e7f0ef",
    );
    app.dispose();
  },
);

it("persists a choice, applies the document, notifies, and restores on a new lifetime", () => {
  const b = browser();
  const app = createAppearance(b.host);
  const changed = vi.fn();
  const unsubscribe = app.subscribe(changed);
  app.setMode("dark");
  expect(b.storage.setItem).toHaveBeenCalledWith(APPEARANCE_KEY, "dark");
  expect(b.root.dataset.colorMode).toBe("dark");
  expect(b.meta.setAttribute).toHaveBeenLastCalledWith("content", "#11181d");
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
  app.setMode("light");
  expect(changed).toHaveBeenCalledOnce();
  app.dispose();
  const next = createAppearance(b.host);
  expect(next.snapshot().mode).toBe("light");
  next.dispose();
});

it("denied reads do not crash either startup path; writes can fail visibly and retry", () => {
  const b = browser();
  b.storage.getItem.mockImplementation(() => {
    throw new Error("denied");
  });
  runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
    get localStorage() {
      throw new Error("denied");
    },
    document: b.host.document,
  });
  expect(b.root.dataset.colorMode).toBe("light");
  const app = createAppearance(b.host);
  expect(app.snapshot().error).toContain("could not be restored");
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("full");
  });
  app.setMode("dark");
  expect(app.snapshot().error).toContain("could not be saved");
  expect(b.root.dataset.colorMode).toBe("dark");
  expect(b.values.has(APPEARANCE_KEY)).toBe(false);
  app.setMode("dark");
  expect(app.snapshot().error).toBeNull();
  expect(b.values.get(APPEARANCE_KEY)).toBe("dark");
  app.dispose();
});

it("cross-window updates re-read current storage, ignore other stores, and dispose", () => {
  const b = browser();
  const app = createAppearance(b.host);
  b.values.set(APPEARANCE_KEY, "dark");
  b.change("another-key");
  b.change(APPEARANCE_KEY, {});
  expect(app.snapshot().mode).toBe("light");
  b.change();
  expect(app.snapshot().mode).toBe("dark");
  expect(b.storage.setItem).not.toHaveBeenCalled();
  b.values.clear();
  b.change(null);
  expect(app.snapshot().mode).toBe("light");
  app.dispose();
  app.dispose();
  expect(b.listeners.size).toBe(0);
  app.setMode("dark");
  expect(app.snapshot().mode).toBe("light");
});

it("rejects an invalid runtime write without saving it", () => {
  const b = browser("dark");
  const app = createAppearance(b.host);
  // External JS callers do not have TypeScript's union guarantee.
  app.setMode("system" as "light");
  expect(app.snapshot().mode).toBe("dark");
  expect(b.storage.setItem).not.toHaveBeenCalled();
  app.dispose();
});

it.each([
  null,
  "",
  "garbage",
  "0",
  "Infinity",
  "0.7",
  "2.1",
  "1.3",
  "2",
  "0.8",
])("bootstrap and font preference agree for %j", (value) => {
  const b = browser("dark");
  if (value !== null) b.values.set(FONT_SCALE_KEY, value);
  runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
    localStorage: b.storage,
    document: b.host.document,
  });
  expect(b.root.style.setProperty).toHaveBeenLastCalledWith(
    "--buzz-text-scale",
    String(parseFontScale(value)),
  );
  const app = createAppearance(b.host);
  expect(app.snapshot().fontScale).toBe(parseFontScale(value));
  expect(app.snapshot().mode).toBe("dark");
  app.dispose();
});
it("font writes clamp, round, recover from failure, sync and preserve color storage", () => {
  const b = browser("dark");
  const app = createAppearance(b.host);
  app.setFontScale(1.1 + 0.1);
  expect(b.values.get(FONT_SCALE_KEY)).toBe("1.2");
  expect(b.values.get(APPEARANCE_KEY)).toBe("dark");
  app.setFontScale(100);
  expect(app.snapshot().fontScale).toBe(2);
  app.setFontScale(0);
  expect(app.snapshot().fontScale).toBe(0.8);
  app.setFontScale(NaN);
  expect(app.snapshot().fontScale).toBe(0.8);
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("full");
  });
  app.setFontScale(1.4);
  expect(app.snapshot().fontError).toContain("could not be saved");
  expect(b.root.style.setProperty).toHaveBeenLastCalledWith(
    "--buzz-text-scale",
    "1.4",
  );
  app.setFontScale(1.4);
  expect(app.snapshot().fontError).toBeNull();
  b.values.set(FONT_SCALE_KEY, "1.6");
  b.change(FONT_SCALE_KEY);
  expect(app.snapshot().fontScale).toBe(1.6);
  b.values.delete(FONT_SCALE_KEY);
  b.change(null);
  expect(app.snapshot().fontScale).toBe(1);
  app.dispose();
  app.setFontScale(2);
  expect(app.snapshot().fontScale).toBe(1);
});
