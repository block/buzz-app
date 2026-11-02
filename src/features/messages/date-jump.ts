export type JumpChoice =
  | "today"
  | "yesterday"
  | "lastWeek"
  | "lastMonth"
  | "beginning";

/** Local-midnight unix seconds of a calendar day. */
export function dayStart(day: Date): number {
  return (
    new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000
  );
}

/** Local-midnight unix seconds for a menu choice; "beginning" is 0. */
export function jumpStart(choice: JumpChoice, now: Date): number {
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  switch (choice) {
    case "today":
      return dayStart(now);
    case "yesterday":
      return dayStart(new Date(year, month, date - 1));
    case "lastWeek":
      return dayStart(new Date(year, month, date - 7));
    case "lastMonth": {
      // Day 0 of this month is the previous month's last day.
      const last = new Date(year, month, 0).getDate();
      return dayStart(new Date(year, month - 1, Math.min(date, last)));
    }
    case "beginning":
      return 0;
  }
}
