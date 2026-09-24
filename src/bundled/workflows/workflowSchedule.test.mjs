import assert from "node:assert/strict";
import { test } from "vitest";

import {
  defaultScheduleTrigger,
  scheduleFormFromTrigger,
  scheduleTriggerFromForm,
  scheduleWeekdaysFromCronField,
} from "./workflowSchedule.ts";

test("new schedules default to daily at 09:00 UTC", () => {
  assert.deepEqual(defaultScheduleTrigger(), {
    on: "schedule",
    cron: "0 9 * * *",
  });
});

test("recognizes the 15m, 30m, and hourly presets", () => {
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: "15m" }).frequency,
    "every_15_minutes",
  );
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: "30m" }).frequency,
    "every_30_minutes",
  );
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: "1h" }).frequency,
    "hourly",
  );
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: " 1h " }).frequency,
    "hourly",
  );
});

test("round-trips daily, weekly, monthly, and custom cron schedules", () => {
  for (const cron of [
    "30 14 * * *",
    "30 14 * * 1-5",
    "30 14 * * 1,3,5",
    "30 14 * * 4",
    "30 14 23 * *",
    "0 */2 * * 1,3,5",
  ]) {
    const form = scheduleFormFromTrigger({ on: "schedule", cron });
    assert.deepEqual(scheduleTriggerFromForm(form), { on: "schedule", cron });
  }
});

test("parses common cron shapes into preset fields", () => {
  assert.deepEqual(
    scheduleFormFromTrigger({ on: "schedule", cron: "5 7 * * *" }),
    {
      customCron: "",
      customInterval: "",
      frequency: "daily",
      monthDay: "1",
      time: "07:05",
      weekday: "2",
    },
  );
  assert.deepEqual(
    scheduleFormFromTrigger({ on: "schedule", cron: "30 14 * * 1-5" }),
    {
      customCron: "",
      customInterval: "",
      frequency: "weekly",
      monthDay: "1",
      time: "14:30",
      weekday: "1-5",
    },
  );
  assert.deepEqual(
    scheduleFormFromTrigger({ on: "schedule", cron: "0 0 31 * *" }),
    {
      customCron: "",
      customInterval: "",
      frequency: "monthly",
      monthDay: "31",
      time: "00:00",
      weekday: "2",
    },
  );
  // Named weekdays, a month restriction and out-of-range hours stay custom.
  for (const cron of ["0 9 * * MON", "0 9 * 6 *", "0 24 * * *", "0 9 1 * 1"]) {
    assert.equal(
      scheduleFormFromTrigger({ on: "schedule", cron }).frequency,
      "custom_cron",
      cron,
    );
  }
});

test("preserves arbitrary custom cron and legacy interval strings exactly", () => {
  const cron = " 0 */2 * * 1,3,5 ";
  const cronForm = scheduleFormFromTrigger({ on: "schedule", cron });
  assert.equal(cronForm.frequency, "custom_cron");
  assert.equal(cronForm.customCron, cron);
  assert.deepEqual(scheduleTriggerFromForm(cronForm), {
    on: "schedule",
    cron,
  });

  const interval = "2h30m";
  const intervalForm = scheduleFormFromTrigger({ on: "schedule", interval });
  assert.equal(intervalForm.frequency, "custom_interval");
  assert.equal(intervalForm.customInterval, interval);
  assert.deepEqual(scheduleTriggerFromForm(intervalForm), {
    on: "schedule",
    interval,
  });
});

test("expands numeric weekday lists and ranges for the weekly picker", () => {
  assert.deepEqual(scheduleWeekdaysFromCronField("1-5"), [
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  assert.deepEqual(scheduleWeekdaysFromCronField("1,3,5"), ["1", "3", "5"]);
  assert.deepEqual(scheduleWeekdaysFromCronField("5,1,3,1"), ["1", "3", "5"]);
  assert.deepEqual(scheduleWeekdaysFromCronField("MON-FRI"), []);
  assert.deepEqual(scheduleWeekdaysFromCronField("5-1"), []);
  assert.deepEqual(scheduleWeekdaysFromCronField("7"), ["7"]);
  assert.deepEqual(scheduleWeekdaysFromCronField("0"), []);
  assert.deepEqual(scheduleWeekdaysFromCronField("0-6"), []);
});

test("switching schedule modes never emits cron and interval together", () => {
  const form = scheduleFormFromTrigger({ on: "schedule", interval: "30m" });
  const custom = scheduleTriggerFromForm({
    ...form,
    customCron: "0 8 * * 6",
    frequency: "custom_cron",
  });

  assert.deepEqual(custom, { on: "schedule", cron: "0 8 * * 6" });
  assert.equal("interval" in custom, false);

  const preset = scheduleTriggerFromForm({
    ...scheduleFormFromTrigger({ on: "schedule", cron: "0 8 * * 6" }),
    frequency: "every_15_minutes",
  });
  assert.deepEqual(preset, { on: "schedule", interval: "15m" });
  assert.equal("cron" in preset, false);
});

test("an emptied cron or interval keeps its custom pane instead of snapping to daily", () => {
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: "" }).frequency,
    "custom_interval",
  );
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", cron: "" }).frequency,
    "custom_cron",
  );
  assert.equal(scheduleFormFromTrigger({ on: "schedule" }).frequency, "daily");
});

test("an unparseable time falls back to 09:00 rather than emitting NaN", () => {
  const form = scheduleFormFromTrigger({ on: "schedule", cron: "0 9 * * *" });
  assert.deepEqual(scheduleTriggerFromForm({ ...form, time: "" }), {
    on: "schedule",
    cron: "0 9 * * *",
  });
});
