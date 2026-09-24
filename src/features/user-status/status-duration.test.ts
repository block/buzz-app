import { expect, it } from "vitest";
import { statusDeadline, statusDuration } from "./status-duration";
it("Today ends at local midnight and This week ends next Monday", () => {
  const thursday = new Date(2026, 8, 24, 18, 37).getTime() / 1000;
  expect(statusDeadline("today", thursday)).toBe(
    new Date(2026, 8, 25).getTime() / 1000,
  );
  expect(statusDeadline("week", thursday)).toBe(
    new Date(2026, 8, 28).getTime() / 1000,
  );
  const monday = new Date(2026, 8, 28, 12).getTime() / 1000;
  expect(statusDeadline("week", monday)).toBe(
    new Date(2026, 9, 5).getTime() / 1000,
  );
  expect(statusDuration(statusDeadline("today", thursday), thursday)).toBe(
    "today",
  );
  expect(statusDuration(thursday + 5000, thursday)).toBe("custom");
});
