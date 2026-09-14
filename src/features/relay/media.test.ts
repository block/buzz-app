import { assert, afterEach, expect, it, vi } from "vitest";
import { createMediaPreparation, saveData, wasIntended } from "./media";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("bounds speculation, charges decoded pixels, and releases active image timers on dispose", async () => {
  vi.useFakeTimers();
  const created: FakeImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 100;
    naturalHeight = 100;
    src = "";
    referrerPolicy = "";
    decode = vi.fn(async () => {});
    constructor() {
      created.push(this);
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const media = createMediaPreparation({ maxBytes: 100_000, maxEntries: 2 });
  media.prepare(["a", "b", "c", "d"]);
  expect(media.stats()).toMatchObject({ active: 2, queued: 2 });
  const first = created[0];
  assert.exists(first);
  assert.exists(first.onload);
  first.onload();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(media.stats().bytes).toBe(40_000);
  const second = created[1];
  assert.exists(second);
  second.naturalWidth = 10000;
  assert.exists(second.onload);
  second.onload();
  expect(second.decode).not.toHaveBeenCalled();
  media.dispose();
  expect(media.stats()).toEqual({
    entries: 0,
    bytes: 0,
    active: 0,
    queued: 0,
    prefetched: 0,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("prefetch warming appends across channels instead of replacing the queue", () => {
  const created: FakeImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 100;
    naturalHeight = 100;
    src = "";
    decode = vi.fn(async () => {});
    constructor() {
      created.push(this);
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const media = createMediaPreparation();
  media.prepare(["focus-1", "focus-2"]);
  // prepare() immediately activates two; a warm pass appends behind them.
  media.warm(["warm-1", "warm-2", "warm-3"]);
  expect(media.stats()).toMatchObject({ queued: 3, prefetched: 3 });
  // A focused prepare intent replaces queued speculation.
  media.prepare(["focus-3"]);
  expect(media.stats()).toMatchObject({ queued: 1, prefetched: 3 });
  expect(wasIntended("warm-1")).toBe(true);
});

it("Save-Data disables warming but nothing else", () => {
  const created: FakeImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    src = "";
    decode = vi.fn(async () => {});
    constructor() {
      created.push(this);
    }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("navigator", { connection: { saveData: true } });
  expect(saveData()).toBe(true);
  const media = createMediaPreparation();
  media.prepare(["a", "b"]);
  media.warm(["c"]);
  expect(media.stats()).toMatchObject({
    active: 0,
    queued: 0,
    prefetched: 0,
  });
  expect(created).toHaveLength(0);

  vi.stubGlobal("navigator", { connection: { saveData: false } });
  media.prepare(["a"]);
  expect(created).toHaveLength(1);

  vi.stubGlobal("navigator", {});
  expect(saveData()).toBe(false);
});
