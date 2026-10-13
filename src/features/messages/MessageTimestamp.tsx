import type { ReactNode } from "react";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  formatDayGroupLabel,
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { useLocalDay } from "../../shared/use-local-day";
import styles from "./Messages.module.css";

/** The divider above a day's first row: "Today", "Monday", "June 20, 2025".
 * `data-day` carries the local calendar day. */
export function DayDivider({ createdAt }: { createdAt: number }) {
  useLocalDay();
  const date = new Date(createdAt * 1000);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
  return (
    <div className={styles.day}>
      <span data-day={day}>{formatDayGroupLabel(createdAt)}</span>
    </div>
  );
}

/** The byline includes a day outside today because its divider can scroll away. */
export function MessageTimestamp({ createdAt }: { createdAt: number }) {
  useLocalDay();
  const date = new Date(createdAt * 1000);
  const fullDate = formatFullTimestamp(createdAt);
  return (
    <Tooltip content={fullDate} delay={500} disableHoverablePopup>
      <time dateTime={date.toISOString()} style={{ cursor: "default" }}>
        <span aria-hidden="true">
          {formatItemTimestamp(createdAt, { withTime: true })}
        </span>
        {/* Keep accessible dates out of copied conversation text. */}
        <span className="sr-only select-none">{fullDate}</span>
      </time>
    </Tooltip>
  );
}

/** Grouped messages keep their date available without an inline clock. */
export function MessageTimestampHint({
  createdAt,
  children,
}: {
  createdAt: number | undefined;
  children: ReactNode;
}) {
  useLocalDay();
  const fullDate =
    createdAt === undefined ? undefined : formatFullTimestamp(createdAt);
  return (
    <Tooltip
      content={fullDate}
      {...(createdAt === undefined ? { open: false } : {})}
      delay={1000}
      disableHoverablePopup
    >
      <div className={styles.messagePayload}>
        {children}
        {createdAt !== undefined && (
          <time
            dateTime={new Date(createdAt * 1000).toISOString()}
            className="sr-only select-none"
          >
            {fullDate}
          </time>
        )}
      </div>
    </Tooltip>
  );
}
