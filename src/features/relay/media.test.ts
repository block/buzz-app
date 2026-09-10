import { assert, afterEach, expect, it, vi } from "vitest";
import { createMediaPreparation } from "./media";

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
  expect(media.stats()).toEqual({ entries: 0, bytes: 0, active: 0, queued: 0 });
  expect(vi.getTimerCount()).toBe(0);
});
