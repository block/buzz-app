import { useState } from "react";
import { CalendarIcon, ClockIcon } from "../../shared/design-system/icons";
import { Calendar } from "../../shared/design-system/ui/Calendar";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { FieldButton } from "../../shared/design-system/ui/FieldButton";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import {
  clockLabel,
  dateLabel,
  localScheduleTime,
  parseScheduleTime,
  quarterHours,
  timeOfDay,
} from "./schedule-time";
import styles from "./ScheduledMessages.module.css";

export function ScheduleDateTime({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange(time: number): void;
  disabled?: boolean;
}) {
  const [day, setDay] = useState(() => localScheduleTime(value).slice(0, 10));
  const [time, setTime] = useState(() => clockLabel(value));
  const [clock, setClock] = useState<string | undefined>(() =>
    localScheduleTime(value).slice(11, 16),
  );
  const [calendar, setCalendar] = useState(false);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last = new Date(Date.now() + 120 * 86_400_000);
  function change(nextDay: string, nextClock: string | undefined) {
    onChange(nextClock ? parseScheduleTime(`${nextDay}T${nextClock}`) : NaN);
  }
  return (
    <div className={styles.dateTime}>
      <PopoverRoot open={calendar} onOpenChange={setCalendar}>
        <PopoverTrigger
          disabled={disabled}
          render={<FieldButton aria-label="Schedule date" />}
        >
          <span className={styles.fieldValue}>
            <CalendarIcon size={16} aria-hidden="true" />
            {dateLabel(new Date(`${day}T12:00`).getTime())}
          </span>
        </PopoverTrigger>
        <PopoverPopup padding="none" aria-label="Choose schedule date">
          <Calendar
            mode="single"
            required
            autoFocus
            selected={new Date(`${day}T12:00`)}
            defaultMonth={new Date(`${day}T12:00`)}
            disabled={[{ before: today }, { after: last }]}
            onSelect={(date) => {
              const next = localScheduleTime(date.getTime()).slice(0, 10);
              setDay(next);
              change(next, clock);
              setCalendar(false);
            }}
          />
        </PopoverPopup>
      </PopoverRoot>
      <Combobox.Root
        items={quarterHours}
        value={quarterHours.find((option) => option.value === clock) ?? null}
        inputValue={time}
        onInputValueChange={(text, details) => {
          // Keep custom typed times when the picker resets its selection on blur.
          if (details.reason !== "input-change") return;
          const parsed =
            timeOfDay(text) ??
            quarterHours.find((option) => option.label === text)?.value;
          setTime(text);
          setClock(parsed);
          change(day, parsed);
        }}
        onValueChange={(option) => {
          if (option) {
            setTime(option.label);
            setClock(option.value);
            change(day, option.value);
          }
        }}
      >
        <Combobox.Control
          label="Schedule time"
          labelVisibility="hidden"
          triggerLabel="Choose schedule time"
          leading={<ClockIcon size={16} aria-hidden="true" />}
          disabled={disabled}
        />
        <Combobox.Popup empty="Type a time, such as 10:15 AM">
          <Combobox.List>
            {(option: (typeof quarterHours)[number]) => (
              <Combobox.Item key={option.value} value={option}>
                {option.label}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </div>
  );
}
