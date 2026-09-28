import { DayPicker, type DayPickerProps } from "react-day-picker";
import { CaretLeftIcon, CaretRightIcon } from "../icons";

/** DayPicker owns date arithmetic, roving focus and calendar keyboard navigation. */
export function Calendar(props: DayPickerProps) {
  return (
    <DayPicker
      showOutsideDays
      {...props}
      className="buzz-calendar"
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
