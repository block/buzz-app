const DAY = 86_400_000;
export const MAX_SCHEDULE_DAYS = 120;
export function localScheduleTime(time: number) {
  const date = new Date(time),
    pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function parseScheduleTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && localScheduleTime(time) === value
    ? time
    : NaN;
}
export const clockLabel = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
export function dateLabel(time: number, now = Date.now()) {
  const date = new Date(time),
    today = new Date(now),
    tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "numeric", day: "numeric", year: "numeric" },
  );
}
export function scheduledLabel(time: number) {
  const day = dateLabel(time);
  return `${day === "Today" || day === "Tomorrow" ? day.toLowerCase() : day} at ${clockLabel(time)}`;
}
export function schedulePresets(now = Date.now()) {
  const later = new Date(now);
  later.setHours(later.getHours() + 4, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    ...(later.toDateString() === new Date(now).toDateString()
      ? [
          {
            label: `Later today at ${clockLabel(later.getTime())}`,
            time: later.getTime(),
          },
        ]
      : []),
    {
      label: `Tomorrow at ${clockLabel(tomorrow.getTime())}`,
      time: tomorrow.getTime(),
    },
    {
      label: `Monday at ${clockLabel(monday.getTime())}`,
      time: monday.getTime(),
    },
  ];
}
export function scheduleError(time: number, now = Date.now()) {
  return !Number.isFinite(time) ||
    time <= now ||
    time > now + MAX_SCHEDULE_DAYS * DAY
    ? "Choose a future time within 120 days."
    : undefined;
}
export function timeOfDay(value: string) {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0),
    period = match[3]?.toUpperCase();
  if (minute > 59 || (period ? hour < 1 || hour > 12 : hour > 23)) return;
  if (period) hour = (hour % 12) + (period === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
export const quarterHours = Array.from({ length: 96 }, (_, index) => {
  const date = new Date(2026, 0, 1, Math.floor(index / 4), (index % 4) * 15);
  return {
    label: clockLabel(date.getTime()),
    value: localScheduleTime(date.getTime()).slice(11, 16),
  };
});
