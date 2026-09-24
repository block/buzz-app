// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowForm } from "./WorkflowForm";
import { DEFAULT_FORM_STATE } from "./workflowFormTypes";

afterEach(cleanup);

it("edits through shared fields and connects trigger help", async () => {
  const user = userEvent.setup();
  function Example() {
    const [state, setState] = useState(DEFAULT_FORM_STATE);
    return <WorkflowForm state={state} onChange={setState} disabled={false} />;
  }
  render(<Example />);
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "A useful workflow",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "A useful workflow",
  );
  await user.click(screen.getByRole("combobox", { name: "Trigger" }));
  await user.click(
    await screen.findByRole("option", { name: "Reaction added" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Emoji (optional)" }),
    "🎉",
  );
  await user.click(screen.getByText("Trigger options"));
  expect(
    screen.getByRole("textbox", { name: "Trigger condition (optional)" }),
  ).toHaveAccessibleDescription(
    "An evalexpr expression; leave empty to match every event of this type.",
  );
  await user.click(screen.getByRole("button", { name: "Add Send Message" }));
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
    <WorkflowForm state={DEFAULT_FORM_STATE} onChange={change} disabled />,
  );
  const description = screen.getByRole("textbox", { name: "Description" });
  const trigger = screen.getByRole("combobox", { name: "Trigger" });
  expect(description).toBeDisabled();
  expect(trigger).toBeDisabled();
  await user.type(description, "No change");
  await user.click(trigger);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
});
