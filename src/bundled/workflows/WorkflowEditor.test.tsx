// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { WorkflowEditor } from "./WorkflowEditor";
import { fixtureYaml } from "./fixtures";

afterEach(cleanup);
function Example({ initial = fixtureYaml }: { initial?: string }) {
  const [yaml, setYaml] = useState(initial);
  return <WorkflowEditor yaml={yaml} onChange={setYaml} onSave={vi.fn()} />;
}

test("form errors follow the editable field and clear when corrected", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const name = screen.getByRole("textbox", { name: "Workflow name" });
  const save = screen.getByRole("button", { name: "Save workflow" });
  await user.clear(name);
  expect(name).toHaveAccessibleDescription("Give this workflow a name.");
  expect(save).toBeDisabled();
  await user.type(name, "Repaired");
  expect(name).not.toHaveAttribute("aria-invalid", "true");
  const text = screen.getByRole("textbox", { name: "Message text" });
  await user.clear(text);
  expect(text).toHaveAccessibleDescription(
    "Each Send Message step needs message text.",
  );
  await user.type(text, "Ready");
  await user.click(screen.getByRole("button", { name: "Add Delay" }));
  const duration = screen.getByRole("textbox", { name: "Delay duration" });
  await user.clear(duration);
  expect(duration).toHaveAttribute("aria-invalid", "true");
  expect(duration).toHaveAccessibleDescription(
    "Each Delay step needs a duration.",
  );
  expect(text).not.toHaveAttribute("aria-invalid", "true");
  await user.type(duration, "5m");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeEnabled();
});

test("YAML errors replace help, retain the draft and restore help after recovery", async () => {
  const user = userEvent.setup();
  render(<Example initial="name: [" />);
  const yaml = screen.getByRole("textbox", { name: "Workflow YAML" });
  expect(yaml).toHaveAttribute("aria-invalid", "true");
  expect(yaml).toHaveAccessibleDescription(
    "The YAML cannot be parsed. Correct it before saving.",
  );
  expect(yaml).toHaveValue("name: [");
  expect(screen.queryByText(/Original text is kept/)).not.toBeInTheDocument();
  await user.clear(yaml);
  await user.paste(fixtureYaml);
  expect(yaml).not.toHaveAttribute("aria-invalid", "true");
  expect(yaml).toHaveAccessibleDescription(/Original text is kept/);
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeEnabled();
});

test("valid advanced YAML stays valid when Form mode cannot represent it", async () => {
  const user = userEvent.setup();
  render(<Example initial={`${fixtureYaml}future: preserve-me\n`} />);
  const yaml = screen.getByRole("textbox", { name: "Workflow YAML" });
  await user.click(screen.getByRole("tab", { name: "Form" }));
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(yaml).not.toHaveAttribute("aria-invalid", "true");
  expect(yaml).toHaveAccessibleDescription(/Original text is kept/);
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeEnabled();
});

test("timeout correction keeps Step options open and the input focused", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByText("Step options", { exact: true }));
  const timeout = screen.getByRole("textbox", {
    name: "Step timeout (optional)",
  });
  const options = timeout.closest("details");
  const save = screen.getByRole("button", { name: "Save workflow" });
  await user.type(timeout, "0s");
  expect(timeout).toHaveAttribute("aria-invalid", "true");
  expect(save).toBeDisabled();
  await user.clear(timeout);
  expect(options).toHaveProperty("open", true);
  expect(timeout).toBeVisible();
  expect(timeout).toHaveFocus();
  expect(save).toBeEnabled();
  for (const character of "30s") {
    await user.keyboard(character);
    expect(options).toHaveProperty("open", true);
    expect(timeout).toBeVisible();
    expect(timeout).toHaveFocus();
  }
  expect(timeout).toHaveValue("30s");
  expect(save).toBeEnabled();
  await user.click(screen.getByText("Step options", { exact: true }));
  expect(options).toHaveProperty("open", false);
});
