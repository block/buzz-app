// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowForm, type WorkflowSelection } from "./WorkflowForm";
import { draftIssue } from "./editor-model";
import {
  formStateToYaml,
  type WorkflowFormState,
  DEFAULT_FORM_STATE,
} from "./workflowFormTypes";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

it("edits through shared fields and connects trigger help", async () => {
  const user = userEvent.setup();
  function Example() {
    const [state, setState] = useState(DEFAULT_FORM_STATE);
    const [selection, onSelect] = useState<WorkflowSelection>({
      type: "trigger",
    });
    return (
      <WorkflowForm
        state={state}
        onChange={setState}
        disabled={false}
        selection={selection}
        onSelect={onSelect}
      />
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("combobox", { name: "Trigger" }));
  await user.click(
    await screen.findByRole("option", { name: "Reaction added" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Emoji (optional)" }),
    "🎉",
  );
  await user.click(screen.getByRole("tab", { name: "Advanced" }));
  expect(
    screen.getByRole("textbox", { name: "Trigger condition (optional)" }),
  ).toHaveAccessibleDescription(
    "An evalexpr expression; leave empty to match every event of this type.",
  );
  await user.click(screen.getByRole("button", { name: "Add step" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Add Send Message" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Message text" }),
    "Hello team",
  );
  expect(screen.getByRole("textbox", { name: "Message text" })).toHaveValue(
    "Hello team",
  );
});

it("keeps the shared choice and text inputs disabled while the form is unavailable", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <WorkflowForm
      state={DEFAULT_FORM_STATE}
      onChange={change}
      disabled
      selection={{ type: "trigger" }}
      onSelect={() => {}}
    />,
  );

  const trigger = screen.getByRole("combobox", { name: "Trigger" });

  expect(trigger).toBeDisabled();

  await user.click(trigger);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
});

it.each(["schedule", "webhook"] as const)(
  "preserves %s when switching directly from a step inspector",
  async (trigger) => {
    const user = userEvent.setup();
    const initial: WorkflowFormState = {
      ...DEFAULT_FORM_STATE,
      trigger:
        trigger === "schedule"
          ? { on: "schedule", cron: "0 9 * * *" }
          : { on: "webhook" },
      steps: [{ id: "step_1", action: "send_message", text: "Hello" }],
    };
    function Example() {
      const [state, setState] = useState(initial);
      const [selection, onSelect] = useState<WorkflowSelection>({
        type: "step",
        id: "step_1",
      });
      return (
        <>
          <WorkflowForm
            state={state}
            onChange={setState}
            disabled={false}
            selection={selection}
            onSelect={onSelect}
          />
          <output>{JSON.stringify(state)}</output>
        </>
      );
    }
    render(<Example />);
    await user.click(
      screen.getByRole("button", {
        name: `Edit trigger: ${trigger === "schedule" ? "Schedule" : "Webhook"}`,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      JSON.stringify(initial),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit step 1: Send Message" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      JSON.stringify(initial),
    );
  },
);

it("keeps Run controls open and timeout focused after correcting an invalid value", async () => {
  const user = userEvent.setup();
  function Example() {
    const [state, setState] = useState<WorkflowFormState>({
      ...DEFAULT_FORM_STATE,
      name: "Timeout regression",
      steps: [
        {
          id: "step_1",
          action: "send_message",
          text: "Hello",
          timeoutSecs: "bad",
        },
      ],
    });
    const [selection, onSelect] = useState<WorkflowSelection>({
      type: "step",
      id: "step_1",
    });
    return (
      <WorkflowForm
        state={state}
        onChange={setState}
        disabled={false}
        issue={draftIssue(formStateToYaml(state))}
        selection={selection}
        onSelect={onSelect}
      />
    );
  }
  render(<Example />);
  const timeout = screen.getByRole("textbox", {
    name: "Step timeout (optional)",
  });
  await user.clear(timeout);
  await user.type(timeout, "30s");
  expect(timeout).toBeVisible();
  expect(timeout).toHaveFocus();
  expect(timeout).toHaveValue("30s");
  expect(screen.getByRole("button", { name: /Run controls/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("returns focus to the selected node after closing the inline inspector", async () => {
  const user = userEvent.setup();
  function Example() {
    const [selection, onSelect] = useState<WorkflowSelection>(null);
    return (
      <WorkflowForm
        state={DEFAULT_FORM_STATE}
        onChange={() => {}}
        disabled={false}
        selection={selection}
        onSelect={onSelect}
      />
    );
  }
  render(<Example />);
  const trigger = screen.getByRole("button", {
    name: "Edit trigger: Message posted",
  });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Close inspector" }));
  expect(trigger).toHaveFocus();
});
