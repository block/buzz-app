export const statusDurations = [
  ["3600", "1 hour"],
  ["28800", "8 hours"],
  ["today", "Today"],
  ["week", "This week"],
  ["custom", "Custom"],
  ["never", "Don’t clear"],
] as const;

export function statusDeadline(duration: string, now: number) {
  const date = new Date(now * 1000);
  if (duration === "today") date.setHours(24, 0, 0, 0);
  else if (duration === "week") {
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
    date.setHours(0, 0, 0, 0);
  } else return now + Number(duration);
  return Math.floor(date.getTime() / 1000);
}

export function statusDuration(
  expiresAt: number | undefined,
  updatedAt: number,
) {
  if (expiresAt === undefined) return "never";
  return (
    statusDurations.find(
      ([value]) =>
        value !== "custom" &&
        value !== "never" &&
        Math.abs(statusDeadline(value, updatedAt) - expiresAt) <= 120,
    )?.[0] ?? "custom"
  );
}
