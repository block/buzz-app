// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPicker, type ModelChoice } from "./ModelPicker";

afterEach(cleanup);

const models: ModelChoice[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus", description: "Most capable" },
];

function setup(
  value = "",
  props: { compact?: boolean; allowCustomModel?: boolean } = {},
) {
  const onChange = vi.fn();
  const view = render(
    <ModelPicker
      models={models}
      allowCustomModel={props.allowCustomModel ?? true}
      value={value}
      defaultLabel="Default model"
      onChange={onChange}
      compact={props.compact ?? false}
    />,
  );
  return { onChange, view, user: userEvent.setup() };
}

const control = () => screen.getByRole("combobox", { name: "Model" });

it("shows the default's label when no model is chosen", () => {
  setup("");
  expect(control()).toHaveTextContent("Default model");
});

it("shows the chosen model's label", () => {
  setup("opus");
  expect(control()).toHaveTextContent("Opus");
});

it("picks a listed model", async () => {
  const { onChange, user } = setup("");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: /Sonnet/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("sonnet");
});

it("picks the default as an empty value", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  await user.click(
    await screen.findByRole("option", { name: /Default model/ }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});

it.each([true, false])(
  "shows a saved unlisted value as unavailable when custom entry is %s",
  async (allowCustomModel) => {
    const { user } = setup("claude-old-1", { allowCustomModel });
    expect(control()).toHaveTextContent("claude-old-1");
    await user.click(control());
    const option = await screen.findByRole("option", { name: /claude-old-1/ });
    expect(option).toHaveTextContent("Unavailable model");
    expect(option).toHaveAttribute("aria-selected", "true");
  },
);

it("uses a dropdown to pick listed models when custom entry is disabled", async () => {
  const { onChange, user } = setup("", { allowCustomModel: false });
  expect(control().tagName).toBe("BUTTON");
  expect(control()).toHaveTextContent("Default model");
  await user.click(control());
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("edits a custom model in a dialog without changing the selection on cancel", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  const custom = await screen.findByRole("option", { name: "Custom model" });
  expect(custom).toHaveAccessibleDescription("Enter a model ID");
  await user.click(custom);
  expect(
    await screen.findByRole("dialog", { name: "Custom model" }),
  ).toBeVisible();
  const modelId = screen.getByRole("textbox", { name: "Model ID" });
  await waitFor(() => expect(modelId).toHaveFocus());
  expect(onChange).not.toHaveBeenCalled();
  await user.type(modelId, "ignored-model");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Custom model" })).toBeNull();
  expect(control()).toHaveTextContent("Opus");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "  claude-custom-1  ",
  );
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-custom-1");
});

it("is disabled as a whole", () => {
  render(
    <ModelPicker
      models={models}
      allowCustomModel
      value=""
      defaultLabel="Default model"
      onChange={vi.fn()}
      disabled
    />,
  );
  expect(control()).toBeDisabled();
});

it("works compact, in the dialog's corner", async () => {
  const { onChange, user } = setup("sonnet", { compact: true });
  expect(control()).toHaveTextContent("Sonnet");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});
