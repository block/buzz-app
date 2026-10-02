// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let launch: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 0;
  });
  document.body.innerHTML =
    '<div id="buzz-launch"><img src="/buzz-loading-mark.svg"></div><div id="root"></div>';
  const element = document.getElementById("buzz-launch");
  if (!element) throw new Error("Missing launch fixture");
  launch = element;
  launch.dataset.startedAt = "0";
  const mark = launch.querySelector("img");
  if (!mark) throw new Error("Missing mark fixture");
  Object.defineProperties(mark, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 72 },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

it("finishes the first cycle before fading when content is ready early", async () => {
  const { setLaunchReady } = await import("./launch");
  vi.advanceTimersByTime(100);
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1659);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(240);
  expect(launch.isConnected).toBe(false);
});

it("keeps looping while content is pending, then finishes the current cycle", async () => {
  const { setLaunchReady } = await import("./launch");
  vi.advanceTimersByTime(2300);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1219);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("cancels a planned fade if content becomes pending again", async () => {
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1000);
  setLaunchReady(false);
  vi.advanceTimersByTime(1000);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1519);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("does not hold the static mark for a cycle with reduced motion", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("keeps looping until the initial visible data settles", async () => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing root fixture");
  const pending = document.createElement("div");
  pending.dataset.buzzLaunchPending = "";
  root.append(pending);
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(4000);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  pending.remove();
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(1279);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
});
