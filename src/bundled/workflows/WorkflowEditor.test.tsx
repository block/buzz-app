// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { WorkflowEditor } from "./WorkflowEditor";
import { fixtureYaml } from "./fixtures";
import { parse } from "yaml";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);
function Example({ initial = fixtureYaml }: { initial?: string }) {
  const [yaml, setYaml] = useState(initial);
  return (
    <WorkflowEditor
      yaml={yaml}
      initialYaml={initial}
      onChange={setYaml}
      onSave={vi.fn()}
    />
  );
}

test("form errors follow the editable field and clear when corrected", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Edit workflow name" }));
  const name = screen.getByRole("textbox", { name: "Workflow name" });
  const save = screen.getByRole("button", { name: "Save changes" });
  await user.clear(name);
  await user.keyboard("{Enter}");
  expect(screen.getByText("Give this workflow a name.")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Edit workflow name" }),
  ).toHaveAccessibleDescription("Give this workflow a name.");
  expect(screen.queryByRole("textbox", { name: "Workflow name" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Edit workflow name" }));
  expect(
    screen.getByRole("textbox", { name: "Workflow name" }),
  ).toHaveAccessibleDescription("Give this workflow a name.");
  expect(save).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Workflow name" }),
    "Repaired",
  );
  await user.keyboard("{Enter}");
  expect(name).not.toHaveAttribute("aria-invalid", "true");
  await user.click(
    screen.getByRole("button", { name: "Edit step 1: Send Message" }),
  );
  const text = screen.getByRole("textbox", { name: "Message text" });
  await user.clear(text);
  expect(text).toHaveAccessibleDescription(
    "Each Send Message step needs message text.",
  );
  await user.type(text, "Ready");
  await user.click(screen.getByRole("button", { name: "Add after Step 1" }));
  await user.click(await screen.findByRole("menuitem", { name: "Add Delay" }));
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
  await user.click(yaml);
  await user.paste(fixtureYaml);
  expect(yaml).not.toHaveAttribute("aria-invalid", "true");
  expect(yaml).toHaveAccessibleDescription(/Original text is kept/);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

test("valid advanced YAML stays valid when Form mode cannot represent it", async () => {
  const user = userEvent.setup();
  render(<Example initial={`${fixtureYaml}future: preserve-me\n`} />);
  const yaml = screen.getByRole("textbox", { name: "Workflow YAML" });
  await user.click(screen.getByRole("tab", { name: "Form" }));
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(yaml).not.toHaveAttribute("aria-invalid", "true");
  expect(yaml).toHaveAccessibleDescription(/Original text is kept/);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

test("timeout correction keeps Step options open and the input focused", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(
    screen.getByRole("button", { name: "Edit step 1: Send Message" }),
  );
  await user.click(screen.getByRole("button", { name: /Run controls/ }));
  const timeout = screen.getByRole("textbox", {
    name: "Step timeout (optional)",
  });
  const options = screen.getByRole("button", { name: /Run controls/ });
  const save = screen.getByRole("button", { name: "Save changes" });
  await user.type(timeout, "0s");
  expect(timeout).toHaveAttribute("aria-invalid", "true");
  expect(save).toBeDisabled();
  await user.clear(timeout);
  expect(options).toHaveAttribute("aria-expanded", "true");
  expect(timeout).toBeVisible();
  expect(timeout).toHaveFocus();
  expect(save).toBeEnabled();
  for (const character of "30s") {
    await user.keyboard(character);
    expect(options).toHaveAttribute("aria-expanded", "true");
    expect(timeout).toBeVisible();
    expect(timeout).toHaveFocus();
  }
  expect(timeout).toHaveValue("30s");
  expect(save).toBeEnabled();
  await user.click(options);
  expect(options).toHaveAttribute("aria-expanded", "false");
});

test("name Escape reverts without rewriting the document", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <WorkflowEditor yaml={fixtureYaml} onChange={change} onSave={vi.fn()} />,
  );
  await user.click(screen.getByRole("button", { name: "Edit workflow name" }));
  const name = screen.getByRole("textbox", { name: "Workflow name" });
  await user.clear(name);
  await user.type(name, "Do not commit this");
  await user.keyboard("{Escape}");
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Edit workflow" })).toBeVisible();
});

test.each([
  fixtureYaml.replace(
    "on: message_posted",
    'on: message_posted\n  filter: \'trigger_text == "a" || trigger_text == "b"\'',
  ),
  `# preserve this comment\nname: Request\nenabled: false\ntrigger:\n  on: webhook\nsteps:\n  - id: request\n    action: call_webhook\n    url: https://example.com/hook\n    future: keep\n`,
])(
  "opening and saving unfamiliar definitions leaves source byte-identical",
  async (yaml) => {
    const user = userEvent.setup();
    const change = vi.fn();
    const save = vi.fn();
    render(
      <WorkflowEditor
        yaml={yaml}
        initialYaml={yaml}
        onChange={change}
        onSave={save}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalled();
  },
);

test("invalid Basic identity cannot silently turn into an unfiltered saved workflow", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(
    screen.getByRole("button", { name: "Edit trigger: Message posted" }),
  );
  await user.click(screen.getByRole("combobox", { name: "Add condition" }));
  await user.click(await screen.findByRole("option", { name: "Author" }));
  await user.type(
    screen.getByRole("textbox", { name: "Value" }),
    "not-a-pubkey",
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  expect(
    screen.queryByRole("textbox", { name: "Workflow YAML" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close inspector" }));
  await user.click(
    screen.getByRole("button", { name: "Edit trigger: Message posted" }),
  );
  expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue(
    "not-a-pubkey",
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

test("clearing an enabled Basic condition blocks save and lossy view switches until removed", async () => {
  const user = userEvent.setup();
  const initial = fixtureYaml
    .replace("enabled: false", "enabled: true")
    .replace(
      "on: message_posted",
      "on: message_posted\n  filter: 'str_contains(trigger_text, \"P1\")'",
    );
  render(<Example initial={initial} />);
  await user.click(
    screen.getByRole("button", { name: "Edit trigger: Message posted" }),
  );
  const value = screen.getByRole("textbox", { name: "Value" });
  await user.clear(value);
  expect(value).toHaveAccessibleDescription(
    "Enter a value or remove this condition.",
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "Advanced" }));
  expect(screen.getByRole("tab", { name: "Basic" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  expect(
    screen.queryByRole("textbox", { name: "Workflow YAML" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close inspector" }));
  await user.click(
    screen.getByRole("button", { name: "Edit trigger: Message posted" }),
  );
  expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Remove Message text condition" }),
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  expect(
    screen.getByRole("textbox", { name: "Workflow YAML" }),
  ).not.toHaveValue(expect.stringContaining("filter:"));
});

test("templated webhook URLs remain saveable in Form and YAML", async () => {
  const user = userEvent.setup();
  const initial =
    'name: Template\nenabled: false\ntrigger: {on: webhook}\nsteps:\n  - id: request\n    action: call_webhook\n    url: "{{trigger_text}}"\n';
  render(<Example initial={initial} />);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
    initial,
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

test.each(["", "   "])(
  "clearing a step condition removes its expression (%j)",
  async (empty) => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(
      screen.getByRole("button", { name: "Edit step 1: Send Message" }),
    );
    await user.click(screen.getByRole("button", { name: /Run controls/ }));
    const condition = screen.getByRole("textbox", {
      name: "Step condition (optional)",
    });
    await user.type(condition, "true");
    await user.clear(condition);
    if (empty) await user.type(condition, empty);
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(
      screen.getByRole("textbox", { name: "Workflow YAML" }),
    ).not.toHaveValue(expect.stringContaining("if:"));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  },
);

test("editing another Basic condition preserves the untouched literal", async () => {
  const user = userEvent.setup();
  const initial = fixtureYaml.replace(
    "on: message_posted",
    `on: message_posted\n  filter: 'str_starts_with(trigger_text, "deploy ")'`,
  );
  render(<Example initial={initial} />);
  await user.click(
    screen.getByRole("button", { name: "Edit trigger: Message posted" }),
  );
  await user.click(screen.getByRole("combobox", { name: "Add condition" }));
  await user.click(await screen.findByRole("option", { name: "Author" }));
  const authorValue = screen.getAllByRole("textbox", { name: "Value" })[1];
  if (!authorValue) throw new Error("Author condition input is missing");
  await user.type(authorValue, "a".repeat(64));
  expect(screen.getAllByRole("textbox", { name: "Value" })[0]).toHaveValue(
    "deploy ",
  );
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  const yaml = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Workflow YAML",
  }).value;
  expect(parse(yaml).trigger.filter).toBe(
    `str_starts_with(trigger_text, "deploy ") && trigger_author == "${"a".repeat(64)}"`,
  );
});
