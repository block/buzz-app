import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayStart, jumpStart } from "./date-jump";

const local = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day).getTime() / 1000;

describe("jumpStart", () => {
  let zone: string | undefined;
  beforeAll(() => {
    zone = process.env.TZ;
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("starts today at local midnight", () => {
    expect(jumpStart("today", new Date(2026, 9, 30, 15))).toBe(
      local(2026, 10, 30),
    );
  });

  it("goes from January 1 back to December 31", () => {
    expect(jumpStart("yesterday", new Date(2026, 0, 1, 9))).toBe(
      local(2025, 12, 31),
    );
  });

  it("lands on yesterday's midnight across a DST change", () => {
    const start = jumpStart("yesterday", new Date(2026, 10, 2, 9));
    expect(start).toBe(local(2026, 11, 1));
    expect(new Date(start * 1000).getHours()).toBe(0);
  });

  it("goes back seven days for last week", () => {
    expect(jumpStart("lastWeek", new Date(2026, 9, 30, 15))).toBe(
      local(2026, 10, 23),
    );
  });

  it("clamps last month to the previous month's last day", () => {
    expect(jumpStart("lastMonth", new Date(2026, 2, 31, 12))).toBe(
      local(2026, 2, 28),
    );
    expect(jumpStart("lastMonth", new Date(2028, 2, 30, 12))).toBe(
      local(2028, 2, 29),
    );
  });

  it("goes from January back to December for last month", () => {
    expect(jumpStart("lastMonth", new Date(2026, 0, 15, 12))).toBe(
      local(2025, 12, 15),
    );
  });

  it("starts the very beginning at zero", () => {
    expect(jumpStart("beginning", new Date(2026, 9, 30))).toBe(0);
  });

  it("starts a calendar day at local midnight", () => {
    expect(dayStart(new Date(2026, 4, 7, 18, 45))).toBe(local(2026, 5, 7));
  });
});
