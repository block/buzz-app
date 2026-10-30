// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelQueries } from "../relay/contracts";
import { useDateJump } from "./use-date-jump";

type Seek = NonNullable<ChannelQueries["seek"]>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A seek per call, each settled by the test. */
function seeks() {
  const calls: {
    from: number;
    signal: AbortSignal;
    resolve(id: string | undefined): void;
    reject(error: unknown): void;
  }[] = [];
  const seek = vi.fn<Seek>(
    (_channelId, from, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ from, signal, resolve, reject });
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  return { channels: { seek } as unknown as ChannelQueries, seek, calls };
}

function setup() {
  const { channels, seek, calls } = seeks();
  const onError = vi.fn();
  const hook = renderHook(() => useDateJump(channels, "c", onError));
  return { hook, seek, calls, onError };
}

it("seeks and targets the returned row", async () => {
  const { hook, seek, calls } = setup();
  act(() => hook.result.current.jump(100));
  expect(seek).toHaveBeenCalledWith("c", 100, expect.any(AbortSignal));
  expect(hook.result.current.pending).toBe(true);
  expect(hook.result.current.target).toBeUndefined();
  await act(async () => calls[0]?.resolve("row"));
  expect(hook.result.current.pending).toBe(false);
  expect(hook.result.current.target).toMatchObject({ messageId: "row" });
  expect(hook.result.current.target?.signal).toBe(calls[0]?.signal);
});

it("a newer jump aborts the previous seek", async () => {
  const { hook, calls, onError } = setup();
  act(() => hook.result.current.jump(100));
  act(() => hook.result.current.jump(200));
  expect(calls[0]?.signal.aborted).toBe(true);
  await act(async () => calls[1]?.resolve("second"));
  expect(hook.result.current.target?.messageId).toBe("second");
  expect(onError).not.toHaveBeenCalled();
});

it("unmount aborts silently", async () => {
  const { hook, calls, onError } = setup();
  act(() => hook.result.current.jump(100));
  hook.unmount();
  expect(calls[0]?.signal.aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(onError).not.toHaveBeenCalled();
});

it("a failed seek reports an error and clears pending", async () => {
  const { hook, calls, onError } = setup();
  act(() => hook.result.current.jump(100));
  await act(async () => calls[0]?.reject(new Error("offline")));
  expect(onError).toHaveBeenCalledOnce();
  expect(hook.result.current.pending).toBe(false);
  expect(hook.result.current.target).toBeUndefined();
});

it("a seek that finds no row reports an error", async () => {
  const { hook, calls, onError } = setup();
  act(() => hook.result.current.jump(100));
  await act(async () => calls[0]?.resolve(undefined));
  expect(onError).toHaveBeenCalledOnce();
  expect(hook.result.current.target).toBeUndefined();
});

it("display deadline shows the error", async () => {
  const { hook, calls, onError } = setup();
  act(() => hook.result.current.jump(100));
  await act(async () => calls[0]?.resolve("row"));
  await act(() => vi.advanceTimersByTimeAsync(4_999));
  expect(onError).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(onError).toHaveBeenCalledOnce();
  expect(calls[0]?.signal.aborted).toBe(true);
  expect(hook.result.current.target).toBeUndefined();
});

it("a completed reveal cancels the deadline", async () => {
  const { hook, calls, onError } = setup();
  act(() => hook.result.current.jump(100));
  await act(async () => calls[0]?.resolve("row"));
  act(() => hook.result.current.revealed());
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(onError).not.toHaveBeenCalled();
  expect(hook.result.current.target?.messageId).toBe("row");
});

it("cancel drops the target without an error", async () => {
  const { hook, calls, onError } = setup();
  act(() => hook.result.current.jump(100));
  await act(async () => calls[0]?.resolve("row"));
  act(() => hook.result.current.cancel());
  expect(calls[0]?.signal.aborted).toBe(true);
  expect(hook.result.current.target).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(onError).not.toHaveBeenCalled();
});
