import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import {
  createRecoverableRead,
  isConnectivityFailure,
} from "./recoverable-read";
import { createRecovery, RECOVERY_DELAYS_MS } from "./recovery";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const network = new TypeError("Failed to fetch");
const denied = new Error("forbidden");

it("classifies only connectivity failures of a settled read", () => {
  expect(isConnectivityFailure({ status: "error", error: network })).toBe(true);
  expect(isConnectivityFailure({ error: network })).toBe(true);
  expect(isConnectivityFailure({ status: "error", error: denied })).toBe(false);
  expect(isConnectivityFailure({ status: "loading", error: network })).toBe(
    false,
  );
  expect(isConnectivityFailure({ status: "ready" })).toBe(false);
  expect(
    isConnectivityFailure({ status: "error", error: "x", transient: true }),
  ).toBe(true);
  expect(
    isConnectivityFailure({
      status: "error",
      error: new ReadError("cancelled", "stopped"),
    }),
  ).toBe(false);
});

it("joins recovery on a connectivity failure and leaves when the read settles", () => {
  const recovery = createRecovery([]);
  const retry = vi.fn();
  const read = createRecoverableRead(recovery, retry);
  expect(read.report({ status: "error", error: network })).toBe(true);
  expect(recovery.snapshot().recovering).toBe(true);
  vi.advanceTimersByTime(RECOVERY_DELAYS_MS[0] ?? 0);
  expect(retry).toHaveBeenCalledTimes(1);
  // Quiet and registered while the retry runs.
  expect(read.report({ status: "loading" })).toBe(true);
  expect(recovery.snapshot().recovering).toBe(true);
  expect(read.report({ status: "ready" })).toBe(false);
  expect(recovery.snapshot().recovering).toBe(false);
  recovery.dispose();
});

it("leaves a denial visible and out of recovery", () => {
  const recovery = createRecovery([]);
  const read = createRecoverableRead(recovery, vi.fn());
  expect(read.report({ status: "error", error: denied })).toBe(false);
  expect(recovery.snapshot().recovering).toBe(false);
  recovery.dispose();
});

it("is quiet without recovery, as in a cached session", () => {
  const read = createRecoverableRead(undefined, vi.fn());
  expect(read.report({ status: "error", error: network })).toBe(true);
  expect(read.report({ status: "ready" })).toBe(false);
});

it("dispose unregisters a failed read", () => {
  const recovery = createRecovery([]);
  const read = createRecoverableRead(recovery, vi.fn());
  read.report({ status: "error", error: network });
  read.dispose();
  expect(recovery.snapshot().recovering).toBe(false);
  recovery.dispose();
});
