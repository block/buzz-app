// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowScheduleFields } from "./WorkflowScheduleFields";
import type { TriggerConfig } from "./workflowFormTypes";

afterEach(cleanup);

function Harness({
  initial,
  onUpdate,
  disabled,
}: {
  initial: TriggerConfig;
  onUpdate?: (trigger: TriggerConfig) => void;
  disabled?: boolean;
}) {
  const [trigger, setTrigger] = useState(initial);
  return (
    <>
      <WorkflowScheduleFields
        trigger={trigger}
        disabled={disabled ?? false}
        onUpdate={(next) => {
          setTrigger(next);
          onUpdate?.(next);
        }}
      />
      <span data-testid="trigger">{JSON.stringify(trigger)}</span>
    </>
  );
}

const preset = (name: string) => screen.getByRole("radio", { name });
const day = (name: string) => screen.getByRole("checkbox", { name });
const trigger = () =>
  JSON.parse(screen.getByTestId("trigger").textContent ?? "{}");

it("offers every preset through the shared radio group and reads a daily cron back", () => {
  render(<Harness initial={{ on: "schedule", cron: "0 9 * * *" }} />);
  expect(
    screen.getByRole("radiogroup", { name: "Repeats" }),
  ).toBeInTheDocument();
  for (const name of [
    "Every 15 minutes",
    "Every 30 minutes",
    "Every hour",
    "Daily",
    "Weekly",
    "Monthly",
    "Custom cron",
  ]) {
    expect(preset(name)).toBeInTheDocument();
  }
  expect(preset("Daily")).toBeChecked();
  expect(screen.getByLabelText("Run time (UTC)")).toHaveValue("09:00");
  expect(screen.queryByRole("group", { name: "Repeat on" })).toBeNull();
  expect(screen.queryByLabelText("Day of month")).toBeNull();
  expect(screen.queryByLabelText("Minute")).toBeNull();
});

it("builds weekly crons from weekday chips and keeps at least one day", async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(
    <Harness
      initial={{ on: "schedule", cron: "0 9 * * *" }}
      onUpdate={onUpdate}
    />,
  );
  await user.click(preset("Weekly"));
  expect(onUpdate).toHaveBeenLastCalledWith({
    on: "schedule",
    cron: "0 9 * * 2",
  });
  expect(screen.getByRole("group", { name: "Repeat on" })).toBeVisible();
  expect(day("Monday")).toBeChecked();
  expect(day("Friday")).not.toBeChecked();

  await user.click(day("Friday"));
  expect(trigger()).toEqual({ on: "schedule", cron: "0 9 * * 2,6" });
  await user.click(day("Sunday"));
  expect(trigger()).toEqual({ on: "schedule", cron: "0 9 * * 1,2,6" });
  await user.click(day("Monday"));
  await user.click(day("Sunday"));
  expect(trigger()).toEqual({ on: "schedule", cron: "0 9 * * 6" });
  // The last selected day cannot be removed.
  await user.click(day("Friday"));
  expect(day("Friday")).toBeChecked();
  expect(trigger()).toEqual({ on: "schedule", cron: "0 9 * * 6" });

  // A time input commits a whole value, not keystrokes.
  fireEvent.change(screen.getByLabelText("Run time (UTC)"), {
    target: { value: "14:30" },
  });
  expect(trigger()).toEqual({ on: "schedule", cron: "30 14 * * 6" });
  expect(screen.getByLabelText("Run time (UTC)")).toHaveValue("14:30");
});

it("warns when a monthly day will be skipped in short months", async () => {
  const user = userEvent.setup();
  render(<Harness initial={{ on: "schedule", cron: "15 6 31 * *" }} />);
  expect(preset("Monthly")).toBeChecked();
  expect(screen.getByLabelText("Run time (UTC)")).toHaveValue("06:15");
  const monthDay = screen.getByRole("combobox", { name: "Day of month" });
  expect(monthDay).toHaveTextContent("31");
  expect(screen.getByRole("status")).toHaveTextContent(
    "This schedule won’t run in some months.",
  );

  monthDay.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("option", { name: "15" });
  await user.keyboard("{Home}{Enter}");
  expect(monthDay).toHaveTextContent("1");
  expect(trigger()).toEqual({ on: "schedule", cron: "15 6 1 * *" });
  expect(screen.queryByRole("status")).toBeNull();
});

it("emits interval presets alone and seeds a custom cron from them", async () => {
  const user = userEvent.setup();
  render(<Harness initial={{ on: "schedule", cron: "0 9 * * *" }} />);
  await user.click(preset("Every 15 minutes"));
  expect(trigger()).toEqual({ on: "schedule", interval: "15m" });
  expect(screen.queryByLabelText("Run time (UTC)")).toBeNull();
  expect(preset("Every 15 minutes")).toBeChecked();

  await user.click(preset("Custom cron"));
  expect(trigger()).toEqual({ on: "schedule", cron: "*/15 * * * *" });
  expect(screen.getByRole("textbox", { name: "Minute" })).toHaveValue("*/15");
  expect(preset("Custom cron")).toBeChecked();

  // Editing the custom expression into a preset shape stays on the custom pane.
  const minute = screen.getByRole("textbox", { name: "Minute" });
  await user.clear(minute);
  await user.type(minute, "0");
  expect(trigger()).toEqual({ on: "schedule", cron: "0 * * * *" });
  expect(preset("Custom cron")).toBeChecked();
  expect(preset("Every hour")).not.toBeChecked();

  await user.click(preset("Every hour"));
  expect(trigger()).toEqual({ on: "schedule", interval: "1h" });
  expect(screen.queryByRole("textbox", { name: "Minute" })).toBeNull();
});

it("keeps a legacy interval editable and flags values under the relay minimum", async () => {
  const user = userEvent.setup();
  render(<Harness initial={{ on: "schedule", interval: "2h" }} />);
  for (const name of ["Every 15 minutes", "Daily", "Custom cron"]) {
    expect(preset(name)).not.toBeChecked();
  }
  const interval = screen.getByLabelText("Existing interval");
  expect(interval).toHaveValue("2h");
  expect(screen.getByText(/Keep this legacy interval/)).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();

  await user.clear(interval);
  await user.type(interval, "45s");
  expect(trigger()).toEqual({ on: "schedule", interval: "45s" });
  expect(screen.getByRole("status")).toHaveTextContent(
    "The relay requires intervals of at least 60 seconds.",
  );

  await user.click(preset("Daily"));
  expect(trigger()).toEqual({ on: "schedule", cron: "0 9 * * *" });
  expect(screen.queryByLabelText("Existing interval")).toBeNull();
});

it("disables every control", () => {
  render(
    <Harness initial={{ on: "schedule", cron: "0 9 * * 1-5" }} disabled />,
  );
  for (const name of ["Daily", "Weekly", "Custom cron"]) {
    expect(preset(name)).toHaveAttribute("aria-disabled", "true");
  }
  expect(day("Monday")).toBeDisabled();
  expect(screen.getByLabelText("Run time (UTC)")).toBeDisabled();
});

// Relay cron 0.16 ordinals, not JavaScript Date or Unix crontab ordinals.
it.each([
  ["Sunday", "1"],
  ["Monday", "2"],
  ["Tuesday", "3"],
  ["Wednesday", "4"],
  ["Thursday", "5"],
  ["Friday", "6"],
  ["Saturday", "7"],
])("reads and writes %s using relay weekday %s", (name, ordinal) => {
  render(<Harness initial={{ on: "schedule", cron: `0 9 * * ${ordinal}` }} />);
  expect(day(name)).toBeChecked();
  fireEvent.change(screen.getByLabelText("Run time (UTC)"), {
    target: { value: "10:15" },
  });
  expect(trigger()).toEqual({ on: "schedule", cron: `15 10 * * ${ordinal}` });
});

it("opens a saved 1-5 range as Sunday through Thursday without changing it", () => {
  const onUpdate = vi.fn();
  render(
    <Harness
      initial={{ on: "schedule", cron: "0 9 * * 1-5" }}
      onUpdate={onUpdate}
    />,
  );
  for (const name of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"])
    expect(day(name)).toBeChecked();
  expect(day("Friday")).not.toBeChecked();
  expect(day("Saturday")).not.toBeChecked();
  expect(trigger().cron).toBe("0 9 * * 1-5");
  expect(onUpdate).not.toHaveBeenCalled();
});
