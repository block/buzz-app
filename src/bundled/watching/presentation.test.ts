import { expect, it } from "vitest";
import type { Watch } from "./model";
import { describe } from "./presentation";

/** Local-time unix seconds, so labels read in the zone the formatter uses. */
const at = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month, day, hour, minute).getTime() / 1_000;
const NOW = at(10, 13, 12); // Fri Nov 13 2026, 12:00 PM local
const DAY = 86_400;
const timer = (
  armed_at: number,
  interval_secs: number,
  more: Partial<Extract<Watch, { type: "timer" }>> = {},
): Watch => ({
  type: "timer",
  interest_id: "attention-manager",
  enabled: true,
  prompt: "Check in",
  armed_at,
  interval_secs,
  max_occurrences: null,
  expires_at: null,
  ...more,
});

it("tells timers on one interval apart by when each runs next", () => {
  const morning = timer(at(10, 1, 8), DAY);
  const evening = timer(at(10, 1, 22), DAY);
  expect(describe(morning, NOW).title).toBe(
    "Every 24h · next Sat, Nov 14 at 8:00 AM",
  );
  expect(describe(evening, NOW).title).toBe("Every 24h · next 10:00 PM");
});

it("counts the next run from the runner's used occurrences", () => {
  // Weekly, first run Sun Nov 1 at 5:00 PM. Until the runner uses the Nov 8
  // run, that run is still the next one, overdue.
  const weekly = timer(at(10, 1, 17) - 7 * DAY, 7 * DAY);
  expect(describe(weekly, NOW).title).toBe(
    "Every 168h · next Sun, Nov 15 at 5:00 PM",
  );
  expect(describe(weekly, NOW, 1).title).toBe(
    "Every 168h · next Sunday at 5:00 PM",
  );
  expect(
    describe(timer(at(10, 13, 9), 3_600, { max_occurrences: 5 }), NOW).title,
  ).toBe("Every 1h · 5 runs · next 1:00 PM");
});

it("reads in the viewer's time zone", async () => {
  const zone = process.env.TZ;
  const daily = timer(Date.UTC(2026, 10, 1, 8) / 1_000, DAY);
  const now = Date.UTC(2026, 10, 13, 12) / 1_000;
  try {
    process.env.TZ = "UTC";
    expect(describe(daily, now).title).toBe(
      "Every 24h · next Sat, Nov 14 at 8:00 AM",
    );
    // The formatter checks the zone again after a microtask checkpoint.
    await Promise.resolve();
    process.env.TZ = "Asia/Tokyo";
    expect(describe(daily, now).title).toBe(
      "Every 24h · next Sat, Nov 14 at 5:00 PM",
    );
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

it("shows a one-shot timer's run time, before and after it runs", () => {
  const once = timer(at(10, 14, 3) - 60, 60, { max_occurrences: 1 });
  expect(describe(once, NOW)).toEqual({
    title: "Once · Sat, Nov 14 at 3:00 AM",
    spent: false,
  });
  expect(describe(once, at(10, 14, 9))).toEqual({
    title: "Once · 3:00 AM",
    spent: true,
  });
});

it("leaves out the next run of a spent or disabled timer", () => {
  const armed = at(10, 1, 8);
  expect(describe(timer(armed, DAY, { max_occurrences: 3 }), NOW)).toEqual({
    title: "Every 24h · 3 runs",
    spent: true,
  });
  expect(describe(timer(armed, DAY, { expires_at: NOW - 1 }), NOW)).toEqual({
    title: "Every 24h",
    spent: true,
  });
  expect(describe(timer(armed, DAY, { enabled: false }), NOW)).toEqual({
    title: "Every 24h",
    spent: false,
  });
});
