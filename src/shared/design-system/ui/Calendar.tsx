import { DayPicker, type DayPickerProps } from "react-day-picker";
import { CaretLeftIcon, CaretRightIcon } from "../icons";

/** DayPicker owns date arithmetic, roving focus and calendar keyboard navigation. */
export function Calendar({
  fill = false,
  ...props
}: DayPickerProps & {
  /** Span the container's width with larger days, for a calendar that is the whole dialog body. */
  fill?: boolean;
}) {
  return (
    <DayPicker
      showOutsideDays
      {...props}
      className={fill ? "buzz-calendar buzz-calendar-fill" : "buzz-calendar"}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <CaretLeftIcon size={16} aria-hidden="true" />
          ) : (
            <CaretRightIcon size={16} aria-hidden="true" />
          ),
      }}
    />
  );
}
