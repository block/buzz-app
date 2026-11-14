import { expect, it } from "vitest";
import type { Watch } from "./model";
import { timerState } from "../../features/agents/attention";
import { describe } from "./presentation";

/** Local-time unix seconds, so labels read in the zone the formatter uses. */
const at = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month, day, hour, minute).getTime() / 1_000;
const NOW = at(10, 13, 12); // Fri Nov 13 2026, 12:00 PM local
const DAY = 86_400;
type Timer = Extract<Watch, { type: "timer" }>;
const timer = (
  armed_at: number,
  interval_secs: number,
  more: Partial<Timer> = {},
): Timer => ({
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

it("counts the next run from the runner's state", () => {
  // Weekly, first run Sun Nov 1 at 5:00 PM. Until the runner uses the Nov 8
  // run, that run is still the next one, overdue.
  const weekly = timer(at(10, 1, 17) - 7 * DAY, 7 * DAY);
  expect(describe(weekly, NOW).title).toBe(
    "Every 168h · next Sun, Nov 15 at 5:00 PM",
  );
  const saved = { armedAt: weekly.armed_at, nextDue: at(10, 8, 17), used: 1 };
  expect(describe(weekly, NOW, saved).title).toBe(
    "Every 168h · next Sunday at 5:00 PM",
  );
  expect(
    describe(timer(at(10, 13, 9), 3_600, { max_occurrences: 5 }), NOW).title,
  ).toBe("Every 1h · 5 runs · next 1:00 PM");
});

it("shows the runner's next run after a late run, an edit or a rearm", () => {
  const hourly = timer(at(10, 13, 8), 3_600);
  // The 9:00 run started late, at noon; the runner set the next for 1:00.
  const late = { armedAt: hourly.armed_at, nextDue: at(10, 13, 13), used: 1 };
  expect(describe(hourly, at(10, 13, 12, 5), late).title).toBe(
    "Every 1h · next 1:00 PM",
  );
  // An interval edit keeps the saved next run.
  expect(
    describe({ ...hourly, interval_secs: 7_200 }, at(10, 13, 12, 5), late)
      .title,
  ).toBe("Every 2h · next 1:00 PM");
  // Rearmed at noon with one used run kept: next is 1:00, not 2:00.
  expect(
    describe(timer(NOW, 3_600), at(10, 13, 12, 5), {
      armedAt: NOW,
      nextDue: at(10, 13, 13),
      used: 1,
    }).title,
  ).toBe("Every 1h · next 1:00 PM");
  // Rearmed at noon with its five used runs kept.
  const rearmed = timer(NOW, 3_600, { max_occurrences: 10 });
  expect(
    describe(rearmed, at(10, 13, 12, 5), {
      armedAt: NOW,
      nextDue: at(10, 13, 13),
      used: 5,
    }).title,
  ).toBe("Every 1h · 10 runs · next 1:00 PM");
});

it("keeps a missed one-shot's configured time once state is saved", () => {
  // Due yesterday at 3:00 and never run: state first saved at noon counts
  // the missed occurrences as used.
  const missed = timer(at(10, 12, 3) - 60, 60, { max_occurrences: 1 });
  expect(describe(missed, NOW, timerState(missed, undefined, NOW))).toEqual({
    title: "Once · Yesterday at 3:00 AM",
    spent: true,
  });
});

it("does not infer a one-shot's run time across an interval edit", () => {
  // It ran at 9:00; an interval edit keeps that state but moves its time.
  const ran = { armedAt: at(10, 13, 8), nextDue: at(10, 13, 10), used: 1 };
  const once = timer(at(10, 13, 8), 3_600, { max_occurrences: 1 });
  expect(describe(once, NOW, ran).title).toBe("Once · 9:00 AM");
  expect(describe({ ...once, interval_secs: 7_200 }, NOW, ran).title).toBe(
    "Once · 10:00 AM",
  );
});

it("promises no run at or after the timer expires", () => {
  const hourly = (expires_at: number) => timer(NOW, 3_600, { expires_at });
  const now = at(10, 13, 12, 5);
  expect(describe(hourly(at(10, 13, 12, 30)), now)).toEqual({
    title: "Every 1h",
    spent: false,
  });
  // A next run exactly at the deadline never starts.
  expect(describe(hourly(at(10, 13, 13)), now).title).toBe("Every 1h");
  // A next run one minute before the deadline still shows.
  expect(describe(hourly(at(10, 13, 13, 1)), now).title).toBe(
    "Every 1h · next 1:00 PM",
  );
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

it("leaves out the next run of a spent, disabled or paused timer", () => {
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
  // Its Interest is paused, so the runner skips it.
  expect(describe(timer(armed, DAY), NOW, undefined, true)).toEqual({
    title: "Every 24h",
    spent: false,
  });
});
