import { expect, it } from "vitest";
import {
  schedulePresets,
  timeOfDay,
  localScheduleTime,
  parseScheduleTime,
  dateLabel,
  scheduleError,
} from "./schedule-time";
it("uses future local quick choices, parses editable times, and keeps cross-year labels compact", () => {
  const now = new Date(2026, 10, 10, 9, 30).getTime(),
    presets = schedulePresets(now);
  expect(presets.map((item) => item.time)).toEqual([
    new Date(2026, 10, 10, 13).getTime(),
    new Date(2026, 10, 11, 9).getTime(),
    new Date(2026, 10, 16, 9).getTime(),
  ]);
  expect(schedulePresets(new Date(2026, 10, 10, 23).getTime())).toHaveLength(2);
  for (const [input, expected] of [
    ["12:00 AM", "00:00"],
    ["12:00 PM", "12:00"],
    ["9:45 am", "09:45"],
    ["23:59", "23:59"],
    ["13:99", undefined],
    ["13 PM", undefined],
    ["nonsense", undefined],
  ])
    expect(timeOfDay(String(input))).toBe(expected);
  const nextYear = new Date(2027, 0, 1, 10).getTime();
  expect(dateLabel(nextYear, now)).toContain("2027");
  expect(parseScheduleTime(localScheduleTime(nextYear))).toBe(nextYear);
  expect(scheduleError(now, now)).toBeTruthy();
  expect(scheduleError(nextYear, now)).toBeUndefined();
});
