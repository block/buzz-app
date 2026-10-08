import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterNextFrameIdle, QUIET_MS } from "./after-next-frame-idle";

// Frames run only when the test runs them; timers on a fake clock.
let frames: FrameRequestCallback[] = [];
const frame = () => {
  for (const callback of frames.splice(0)) callback(0);
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});
afterEach(() => {
  frames = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("without requestIdleCallback, runs once the caller is quiet for a moment after the next frame", () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  const run = vi.fn(() => true);
  const idle = afterNextFrameIdle(run);
  idle.quiet();
  vi.advanceTimersByTime(QUIET_MS * 5);
  expect(run).not.toHaveBeenCalled();
  frame();
  // Not a task right after that frame: each reported activity starts over.
  vi.advanceTimersByTime(QUIET_MS - 1);
  idle.quiet();
  vi.advanceTimersByTime(QUIET_MS - 1);
  expect(run).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(run).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(QUIET_MS * 5);
  expect(run).toHaveBeenCalledTimes(1);
});

it("cancels before or after the next frame", () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  const run = vi.fn(() => true);
  afterNextFrameIdle(run).cancel();
  frame();
  const idle = afterNextFrameIdle(run);
  frame();
  idle.cancel();
  // A report after the cancel does not start the wait again.
  idle.quiet();
  vi.advanceTimersByTime(QUIET_MS * 5);
  expect(run).not.toHaveBeenCalled();
});

it("with requestIdleCallback, runs in the first idle period after the next frame", () => {
  const idles: (() => void)[] = [];
  const cancelIdle = vi.fn();
  vi.stubGlobal("requestIdleCallback", (callback: () => void) =>
    idles.push(callback),
  );
  vi.stubGlobal("cancelIdleCallback", cancelIdle);
  const run = vi.fn(() => true);
  const idle = afterNextFrameIdle(run);
  expect(idles).toHaveLength(0);
  frame();
  expect(idles).toHaveLength(1);
  idle.quiet();
  vi.advanceTimersByTime(QUIET_MS * 5);
  expect(run).not.toHaveBeenCalled();
  idles[0]?.();
  expect(run).toHaveBeenCalledTimes(1);
  idle.cancel();
  expect(cancelIdle).toHaveBeenCalledWith(1);
});

it("without requestIdleCallback, continues in the following tasks until done, whatever it scrolls", () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  let left = 3;
  const run = vi.fn(() => --left === 0);
  const idle = afterNextFrameIdle(run);
  frame();
  vi.advanceTimersByTime(QUIET_MS);
  expect(run).toHaveBeenCalledTimes(1);
  // Its own work scrolls: reports no longer start the wait over, and the
  // next slice is the next task (a zero delay, which the fake clock runs 1 ms
  // later).
  idle.quiet();
  vi.advanceTimersByTime(1);
  expect(run).toHaveBeenCalledTimes(2);
  idle.quiet();
  vi.advanceTimersByTime(1);
  expect(run).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(QUIET_MS * 5);
  expect(run).toHaveBeenCalledTimes(3);
});

it("cancels between slices", () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  const run = vi.fn(() => false);
  const idle = afterNextFrameIdle(run);
  frame();
  vi.advanceTimersByTime(QUIET_MS);
  expect(run).toHaveBeenCalledTimes(1);
  idle.cancel();
  vi.advanceTimersByTime(QUIET_MS * 5);
  expect(run).toHaveBeenCalledTimes(1);
});

it("with requestIdleCallback, continues in later idle periods until done", () => {
  const idles: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) =>
    idles.push(callback),
  );
  let left = 2;
  const run = vi.fn(() => --left === 0);
  afterNextFrameIdle(run);
  frame();
  idles[0]?.();
  expect(idles).toHaveLength(2);
  idles[1]?.();
  expect(run).toHaveBeenCalledTimes(2);
  expect(idles).toHaveLength(2);
});

it("with requestIdleCallback, cancels the pending slice", () => {
  const idles: (() => void)[] = [];
  const cancelIdle = vi.fn();
  vi.stubGlobal("requestIdleCallback", (callback: () => void) =>
    idles.push(callback),
  );
  vi.stubGlobal("cancelIdleCallback", cancelIdle);
  const idle = afterNextFrameIdle(() => false);
  frame();
  idles[0]?.();
  idle.cancel();
  expect(cancelIdle).toHaveBeenCalledWith(2);
});
