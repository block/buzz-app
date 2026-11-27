import { expect, it } from "vitest";
import { ContextMeter, ContextMeters, contextSize } from "./context-meter";

it("reads only a positive whole count as a context size", () => {
  expect(contextSize(435_123)).toBe(435_123);
  for (const value of [0, -1, 1.5, Number.NaN, "435123", undefined, 2 ** 60])
    expect(contextSize(value)).toBeUndefined();
});

it("keeps the last size a session reported", () => {
  const meter = new ContextMeter();
  expect(meter.tokens).toBeUndefined();
  meter.report(1_000);
  meter.report(435_123);
  meter.report(0);
  meter.report("lots");
  expect(meter.tokens).toBe(435_123);
});

it("keeps each session's size apart until it is forgotten", () => {
  const meters = new ContextMeters();
  meters.report("a", 1_000);
  meters.report("b", 2_000);
  meters.report("c", 0);
  expect([meters.tokens("a"), meters.tokens("b"), meters.tokens("c")]).toEqual([
    1_000,
    2_000,
    undefined,
  ]);
  meters.forget("a");
  expect(meters.tokens("a")).toBeUndefined();
  meters.clear();
  expect(meters.tokens("b")).toBeUndefined();
  expect(meters.tokens(undefined)).toBeUndefined();
});
