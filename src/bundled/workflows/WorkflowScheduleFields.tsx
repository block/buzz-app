import { useId, useState } from "react";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { CronExpressionInput } from "./CronExpressionInput";
import { parseDurationSeconds } from "./workflowDuration";
import type { TriggerConfig } from "./workflowFormTypes";
import {
  SCHEDULE_FREQUENCIES,
  SCHEDULE_FREQUENCY_LABELS,
  type ScheduleFormState,
  scheduleFormFromTrigger,
  scheduleTriggerFromForm,
  scheduleWeekdaysFromCronField,
} from "./workflowSchedule";

const WEEKDAYS = [
  ["1", "Sunday", "S"],
  ["2", "Monday", "M"],
  ["3", "Tuesday", "T"],
  ["4", "Wednesday", "W"],
  ["5", "Thursday", "T"],
  ["6", "Friday", "F"],
  ["7", "Saturday", "S"],
] as const;

const MONTH_DAY_GROUPS = [
  {
    label: "",
    options: Array.from({ length: 31 }, (_, index) => {
      const day = String(index + 1);
      return { value: day, label: day };
    }),
  },
];

/** The relay's scheduler ticks once a minute, so it refuses shorter intervals. */
const MINIMUM_INTERVAL_SECONDS = 60;

function monthlyDayWarning(monthDay: string): string | null {
  return Number(monthDay) > 28
    ? "This schedule won’t run in some months."
    : null;
}

function intervalWarning(interval: string): string | null {
  const seconds = parseDurationSeconds(interval);
  return seconds !== null && seconds < MINIMUM_INTERVAL_SECONDS
    ? "The relay requires intervals of at least 60 seconds."
    : null;
}

/** Start a custom expression from the preset it replaces, not a blank row. */
function customCronSeed(schedule: ScheduleFormState): string {
  const currentTrigger = scheduleTriggerFromForm(schedule);
  if (currentTrigger.cron) return currentTrigger.cron;

  switch (currentTrigger.interval) {
    case "15m":
      return "*/15 * * * *";
    case "30m":
      return "*/30 * * * *";
    case "1h":
      return "0 * * * *";
    default:
      return "";
  }
}

export function WorkflowScheduleFields({
  disabled = false,
  onUpdate,
  trigger,
}: {
  disabled?: boolean;
  onUpdate: (trigger: TriggerConfig) => void;
  trigger: TriggerConfig;
}) {
  const id = useId();
  // A custom expression that happens to read as a preset stays on the custom
  // pane while it is being edited, instead of snapping back to that preset.
  const [forceCustomCron, setForceCustomCron] = useState(false);
  const parsedSchedule = scheduleFormFromTrigger(trigger);
  const schedule: ScheduleFormState = forceCustomCron
    ? {
        ...parsedSchedule,
        customCron: trigger.cron ?? parsedSchedule.customCron,
        frequency: "custom_cron",
      }
    : parsedSchedule;
  const updateSchedule = (updates: Partial<ScheduleFormState>) => {
    onUpdate(scheduleTriggerFromForm({ ...schedule, ...updates }));
  };
  const usesTime =
    schedule.frequency === "daily" ||
    schedule.frequency === "weekly" ||
    schedule.frequency === "monthly";
  const selectedWeekdays = new Set(
    scheduleWeekdaysFromCronField(schedule.weekday),
  );
  const monthWarning =
    schedule.frequency === "monthly"
      ? monthlyDayWarning(schedule.monthDay)
      : null;
  const legacyIntervalWarning =
    schedule.frequency === "custom_interval"
      ? intervalWarning(schedule.customInterval)
      : null;

  return (
    <div className="workflow-schedule">
      <fieldset className="workflow-pills">
        <legend className="buzz-field-label">Repeats</legend>
        <div className="workflow-pill-grid" data-columns="2">
          {SCHEDULE_FREQUENCIES.map((frequency) => {
            const inputId = `${id}-frequency-${frequency}`;
            return (
              <div
                key={frequency}
                className="workflow-pill"
                data-span={frequency === "custom_cron" ? "2" : undefined}
              >
                <input
                  type="radio"
                  className="sr-only workflow-pill-input"
                  id={inputId}
                  name={`${id}-frequency`}
                  value={frequency}
                  checked={schedule.frequency === frequency}
                  disabled={disabled}
                  onChange={() => {
                    const isCustom = frequency === "custom_cron";
                    setForceCustomCron(isCustom);
                    updateSchedule({
                      customCron: isCustom
                        ? customCronSeed(schedule)
                        : schedule.customCron,
                      frequency,
                    });
                  }}
                />
                <label htmlFor={inputId} className="workflow-pill-label">
                  {SCHEDULE_FREQUENCY_LABELS[frequency]}
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      {schedule.frequency === "weekly" && (
        <fieldset className="workflow-pills">
          <legend className="buzz-field-label">Repeat on</legend>
          <div className="workflow-pill-grid" data-columns="7">
            {WEEKDAYS.map(([value, label, shortLabel]) => {
              const inputId = `${id}-weekday-${value}`;
              return (
                <div key={value} className="workflow-pill" data-shape="round">
                  <input
                    type="checkbox"
                    className="sr-only workflow-pill-input"
                    id={inputId}
                    aria-label={label}
                    value={value}
                    checked={selectedWeekdays.has(value)}
                    disabled={disabled}
                    onChange={() => {
                      const nextWeekdays = new Set(selectedWeekdays);
                      if (nextWeekdays.has(value)) {
                        // A weekly schedule needs at least one day.
                        if (nextWeekdays.size === 1) return;
                        nextWeekdays.delete(value);
                      } else {
                        nextWeekdays.add(value);
                      }
                      updateSchedule({
                        weekday: WEEKDAYS.map(([day]) => day)
                          .filter((day) => nextWeekdays.has(day))
                          .join(","),
                      });
                    }}
                  />
                  <label htmlFor={inputId} className="workflow-pill-label">
                    {shortLabel}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      {schedule.frequency === "monthly" && (
        <div className="workflow-field">
          <Select
            variant="field"
            label="Day of month"
            value={schedule.monthDay}
            groups={MONTH_DAY_GROUPS}
            disabled={disabled}
            onValueChange={(monthDay) => updateSchedule({ monthDay })}
          />
          {monthWarning && (
            <p role="status" className="text-body-sm text-warning">
              {monthWarning}
            </p>
          )}
        </div>
      )}

      {usesTime && (
        <label htmlFor={`${id}-time`} className="workflow-field">
          Run time (UTC)
          <Input
            id={`${id}-time`}
            type="time"
            value={schedule.time}
            disabled={disabled}
            onValueChange={(time) => updateSchedule({ time })}
          />
        </label>
      )}

      {schedule.frequency === "custom_cron" && (
        <CronExpressionInput
          disabled={disabled}
          value={schedule.customCron}
          onChange={(customCron) => updateSchedule({ customCron })}
        />
      )}

      {schedule.frequency === "custom_interval" && (
        <div className="workflow-field">
          <label htmlFor={`${id}-interval`}>Existing interval</label>
          <Input
            id={`${id}-interval`}
            aria-describedby={`${id}-interval-help`}
            value={schedule.customInterval}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            onValueChange={(customInterval) =>
              updateSchedule({ customInterval })
            }
          />
          <span
            id={`${id}-interval-help`}
            className="text-body-sm text-secondary"
          >
            Keep this legacy interval or choose a repeat option above. All
            schedules use UTC.
          </span>
          {legacyIntervalWarning && (
            <p role="status" className="text-body-sm text-warning">
              {legacyIntervalWarning}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
