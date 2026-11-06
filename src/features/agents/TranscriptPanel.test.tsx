// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsContext } from "./react";
import type { Agents } from "./service";
import { LIVE_READ_MS, useLiveTranscript } from "./TranscriptPanel";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A read whose calls each settle when the test says. */
function reads() {
  const calls: {
    key: string;
    signal: AbortSignal;
    resolve(value: string | undefined): void;
    reject(error: Error): void;
  }[] = [];
  const read = (key: string) => (signal: AbortSignal) =>
    new Promise<string | undefined>((resolve, reject) =>
      calls.push({ key, signal, resolve, reject }),
    );
  return { calls, read };
}

function setup() {
  const steps = new Set<() => void>();
  const agents = {
    subscribeSteps: (_agent: string, listener: () => void) => {
      steps.add(listener);
      return () => void steps.delete(listener);
    },
  } as unknown as Agents;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AgentsContext.Provider value={agents}>{children}</AgentsContext.Provider>
  );
  const { calls, read } = reads();
  const view = renderHook(
    ({ key, working }: { key: string; working: boolean }) =>
      useLiveTranscript(read(key), key, working, "agent"),
    { wrapper, initialProps: { key: "a", working: false } },
  );
  const step = () =>
    act(() => {
      for (const listener of steps) listener();
    });
  return { calls, view, steps, step };
}
function nth<T>(items: readonly T[], index: number) {
  const item = items[index];
  if (!item) throw new Error(`No read ${index}`);
  return item;
}
const settle = (call: { resolve(value: string): void }, value: string) =>
  act(async () => call.resolve(value));

it("reads on open and keeps its result while the next read runs", async () => {
  const { calls, view } = setup();
  expect(calls).toHaveLength(1);
  expect(view.result.current.loading).toBe(true);
  await settle(nth(calls, 0), "first");
  expect(view.result.current.shown.transcript).toBe("first");
  expect(view.result.current.loading).toBe(false);
  act(() => view.result.current.refresh());
  expect(calls).toHaveLength(2);
  expect(view.result.current.loading).toBe(true);
  expect(view.result.current.shown.transcript).toBe("first");
  await act(async () => nth(calls, 1).reject(new Error("busy")));
  expect(view.result.current.shown).toMatchObject({
    transcript: "first",
    error: "busy",
  });
});

it("polls only while working, and stops when idle", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(1);
  // A turn starting reads at once, then on each interval.
  view.rerender({ key: "a", working: true });
  expect(calls).toHaveLength(2);
  await settle(nth(calls, 1), "b");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS));
  expect(calls).toHaveLength(3);
  await settle(nth(calls, 2), "c");
  // The turn ending reads once more, and the timer stops.
  view.rerender({ key: "a", working: false });
  expect(calls).toHaveLength(4);
  await settle(nth(calls, 3), "d");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(4);
});

it("never overlaps reads, and reads once more after one asked during it", async () => {
  const { calls, view, step } = setup();
  view.rerender({ key: "a", working: true });
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 4));
  step();
  act(() => view.result.current.refresh());
  expect(calls).toHaveLength(1);
  await settle(nth(calls, 0), "first");
  expect(calls).toHaveLength(2);
  expect(view.result.current.loading).toBe(true);
  await settle(nth(calls, 1), "second");
  expect(calls).toHaveLength(2);
  expect(view.result.current.loading).toBe(false);
});

it("reads at once when the agent reports a step, only while working", async () => {
  const { calls, view, steps, step } = setup();
  await settle(nth(calls, 0), "a");
  expect(steps.size).toBe(0);
  view.rerender({ key: "a", working: true });
  await settle(nth(calls, 1), "b");
  step();
  expect(calls).toHaveLength(3);
  await settle(nth(calls, 2), "c");
  view.rerender({ key: "a", working: false });
  expect(steps.size).toBe(0);
});

it("does not poll while the window is hidden", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  view.rerender({ key: "a", working: true });
  await settle(nth(calls, 1), "b");
  act(() => vi.advanceTimersByTime(LIVE_READ_MS * 3));
  expect(calls).toHaveLength(2);
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(calls).toHaveLength(3);
  hidden.mockRestore();
});

it("ignores a slow read that finishes after switching conversations", async () => {
  const { calls, view } = setup();
  await settle(nth(calls, 0), "a");
  act(() => view.result.current.refresh());
  view.rerender({ key: "b", working: false });
  expect(nth(calls, 1).signal.aborted).toBe(true);
  expect(view.result.current.shown.transcript).toBeUndefined();
  await settle(nth(calls, 1), "late a");
  expect(view.result.current.shown.transcript).toBeUndefined();
  await settle(nth(calls, 2), "b");
  expect(view.result.current.shown.transcript).toBe("b");
});

it("shows a missing transcript as null", async () => {
  const { calls, view } = setup();
  await act(async () => nth(calls, 0).resolve(undefined));
  expect(view.result.current.shown.transcript).toBeNull();
});
