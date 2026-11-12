// Adapted from block/buzz desktop workflow helpers at b9392d9d.
import type { TriggerConfig } from "./workflowFormTypes";
import calendarTimezones from "./calendar-timezones.json";

export type CalendarSchedule = {
  every_weeks: number;
  start_date: string;
  time: string;
  timezone: string;
};

// The relay pins chrono-tz 0.10.4. This is its name table, not the browser's
// canonicalized zone list (which can drop aliases or accept different casing).
const relayTimezones = new Set(calendarTimezones);

export function calendarScheduleError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Calendar schedule requires every_weeks, start_date, time and timezone.";
  const calendar = value as Record<string, unknown>;
  if (
    Object.keys(calendar).some(
      (key) => !["every_weeks", "start_date", "time", "timezone"].includes(key),
    )
  )
    return "Unsupported calendar field. Keep this definition in YAML.";
  if (calendar.every_weeks !== 2) return "Calendar every_weeks must be 2.";
  const date = calendar.start_date;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    return "Enter a real first date in YYYY-MM-DD format.";
  if (
    typeof calendar.time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(calendar.time)
  )
    return "Enter a local run time in HH:MM format.";
  if (
    typeof calendar.timezone !== "string" ||
    !relayTimezones.has(calendar.timezone)
  )
    return "Enter a supported case-sensitive IANA timezone, such as UTC or America/New_York.";
  return null;
}

/** Only the new calendar arm is strict. Legacy schedule parsing stays unchanged. */
export function calendarTriggerError(
  trigger: Record<string, unknown>,
): string | null {
  if (trigger.on !== "schedule" || trigger.calendar === undefined) return null;
  if (
    Object.keys(trigger).some(
      (key) => !["on", "cron", "interval", "calendar"].includes(key),
    ) ||
    trigger.cron != null ||
    trigger.interval != null
  )
    return "Calendar schedules cannot include cron, interval or other trigger fields.";
  return calendarScheduleError(trigger.calendar);
}

export const SCHEDULE_FREQUENCIES = [
  "every_15_minutes",
  "every_30_minutes",
  "hourly",
  "daily",
  "weekly",
  "every_two_weeks",
  "monthly",
  "custom_cron",
] as const;

export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];
/** Legacy intervals that match no preset are kept editable, never offered. */
export type ScheduleFormFrequency = ScheduleFrequency | "custom_interval";

export type ScheduleFormState = {
  customCron: string;
  customInterval: string;
  frequency: ScheduleFormFrequency;
  monthDay: string;
  startDate: string;
  time: string;
  timezone: string;
  weekday: string;
};

export const SCHEDULE_FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  every_15_minutes: "Every 15 minutes",
  every_30_minutes: "Every 30 minutes",
  hourly: "Every hour",
  daily: "Daily",
  weekly: "Weekly",
  every_two_weeks: "Every two weeks",
  monthly: "Monthly",
  custom_cron: "Custom cron",
};

const INTERVAL_FREQUENCIES: Readonly<Record<string, ScheduleFrequency>> = {
  "15m": "every_15_minutes",
  "30m": "every_30_minutes",
  "1h": "hourly",
};

const FREQUENCY_INTERVALS: Partial<Record<ScheduleFormFrequency, string>> = {
  every_15_minutes: "15m",
  every_30_minutes: "30m",
  hourly: "1h",
};

const DEFAULT_TIME = "09:00";
// Relay cron ordinals: Sunday=1 through Saturday=7.
const DEFAULT_WEEKDAY = "2";
const DEFAULT_MONTH_DAY = "1";

type ParsedCommonCron = {
  frequency: "daily" | "weekly" | "monthly";
  monthDay?: string;
  time: string;
  weekday?: string;
};

/** Numeric weekday lists and ranges only; named days fall back to custom cron. */
export function scheduleWeekdaysFromCronField(field: string): string[] {
  const weekdays = new Set<number>();
  for (const segment of field.split(",")) {
    if (/^[1-7]$/.test(segment)) {
      weekdays.add(Number(segment));
      continue;
    }

    const range = /^([1-7])-([1-7])$/.exec(segment);
    if (!range || Number(range[1]) > Number(range[2])) return [];
    for (let day = Number(range[1]); day <= Number(range[2]); day += 1) {
      weekdays.add(day);
    }
  }
  return [...weekdays].sort((left, right) => left - right).map(String);
}

function parseCommonCron(cron: string): ParsedCommonCron | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute = "", hour = "", monthDay = "", month = "", weekday = ""] =
    fields;
  const parsedMinute = Number(minute);
  const parsedHour = Number(hour);
  if (
    !/^\d+$/.test(minute) ||
    !/^\d+$/.test(hour) ||
    parsedMinute < 0 ||
    parsedMinute > 59 ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    month !== "*"
  ) {
    return null;
  }

  const time = `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
  if (monthDay === "*" && weekday === "*") {
    return { frequency: "daily", time };
  }
  if (monthDay === "*" && scheduleWeekdaysFromCronField(weekday).length > 0) {
    return { frequency: "weekly", time, weekday };
  }
  if (weekday === "*" && /^(?:[1-9]|[12]\d|3[01])$/.test(monthDay)) {
    return { frequency: "monthly", monthDay, time };
  }
  return null;
}

export function scheduleFormFromTrigger(
  trigger: TriggerConfig,
): ScheduleFormState {
  if (trigger.calendar) {
    return {
      customCron: "",
      customInterval: "",
      frequency: "every_two_weeks",
      monthDay: DEFAULT_MONTH_DAY,
      weekday: DEFAULT_WEEKDAY,
      startDate: trigger.calendar.start_date,
      time: trigger.calendar.time,
      timezone: trigger.calendar.timezone,
    };
  }
  // A key that is present but empty keeps its custom pane mounted while the
  // user clears and retypes it; only a missing key falls back to daily.
  const interval = trigger.interval;
  if (interval !== undefined) {
    const frequency = INTERVAL_FREQUENCIES[interval.trim()];
    return {
      customCron: "",
      customInterval: frequency ? "" : interval,
      frequency: frequency ?? "custom_interval",
      monthDay: DEFAULT_MONTH_DAY,
      startDate: "",
      time: DEFAULT_TIME,
      timezone: "UTC",
      weekday: DEFAULT_WEEKDAY,
    };
  }

  const cron = trigger.cron;
  const commonCron = cron ? parseCommonCron(cron) : null;
  return {
    customCron: commonCron ? "" : (cron ?? ""),
    customInterval: "",
    frequency:
      commonCron?.frequency ?? (cron !== undefined ? "custom_cron" : "daily"),
    monthDay: commonCron?.monthDay ?? DEFAULT_MONTH_DAY,
    startDate: "",
    time: commonCron?.time ?? DEFAULT_TIME,
    timezone: "UTC",
    weekday: commonCron?.weekday ?? DEFAULT_WEEKDAY,
  };
}

function cronTrigger(cron: string): TriggerConfig {
  return { on: "schedule", cron };
}

function intervalTrigger(interval: string): TriggerConfig {
  return { on: "schedule", interval };
}

function cronTime(time: string): { hour: string; minute: string } {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return { hour: "9", minute: "0" };
  return {
    hour: String(Number(match[1])),
    minute: String(Number(match[2])),
  };
}

/** Switching arms deliberately removes incompatible schedule fields. */
export function scheduleTriggerFromForm(
  form: ScheduleFormState,
): TriggerConfig {
  if (form.frequency === "every_two_weeks") {
    return {
      on: "schedule",
      calendar: {
        every_weeks: 2,
        start_date: form.startDate,
        time: form.time,
        timezone: form.timezone,
      },
    };
  }
  const interval = FREQUENCY_INTERVALS[form.frequency];
  if (interval) return intervalTrigger(interval);
  if (form.frequency === "custom_interval") {
    return intervalTrigger(form.customInterval);
  }
  if (form.frequency === "custom_cron") {
    return cronTrigger(form.customCron);
  }

  const { hour, minute } = cronTime(form.time);
  switch (form.frequency) {
    case "weekly":
      return cronTrigger(`${minute} ${hour} * * ${form.weekday}`);
    case "monthly":
      return cronTrigger(`${minute} ${hour} ${form.monthDay} * *`);
    default:
      return cronTrigger(`${minute} ${hour} * * *`);
  }
}

export function defaultScheduleTrigger(): TriggerConfig {
  return scheduleTriggerFromForm(scheduleFormFromTrigger({ on: "schedule" }));
}
