// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelPicker, type ModelChoice } from "./ModelPicker";

beforeEach(() => {
  // jsdom has no layout observers; the compact picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
const input = () => control() as HTMLInputElement;

it("shows the default's label when no model is chosen", () => {
  setup("");
  expect(input()).toHaveValue("Default model");
});

it("shows the chosen model's label", () => {
  setup("opus");
  expect(input()).toHaveValue("Opus");
});

it("picks a listed model", async () => {
  const { onChange, user } = setup("");
  await user.click(input());
  await user.click(await screen.findByRole("option", { name: /Sonnet/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("sonnet");
});

it("picks the default as an empty value", async () => {
  const { onChange, user } = setup("opus");
  await user.click(input());
  await user.click(
    await screen.findByRole("option", { name: /Default model/ }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});

it.each([
  ["field", () => input()],
  [
    "browse button",
    () => screen.getByRole("button", { name: "Browse models" }),
  ],
] as const)(
  "replaces the full value after opening from the %s",
  async (_name, opener) => {
    const { user } = setup("opus");
    await user.click(opener());
    await waitFor(() => {
      expect(input().selectionStart).toBe(0);
      expect(input().selectionEnd).toBe("Opus".length);
    });
    await user.keyboard("x");
    expect(input()).toHaveValue("x");
  },
);

it("commits a typed custom ID on Enter", async () => {
  const { onChange, user } = setup("");
  await user.clear(input());
  await user.type(input(), "my-model-1{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("my-model-1");
});

it("commits a typed custom ID when focus leaves", async () => {
  const { onChange, user } = setup("");
  await user.clear(input());
  await user.type(input(), "  my-model-2  ");
  await user.tab();
  expect(onChange).toHaveBeenLastCalledWith("my-model-2");
});

it("commits a typed label as that model's ID", async () => {
  const { onChange, user } = setup("");
  await user.clear(input());
  await user.type(input(), "Opus");
  await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("opus");
});

it.each([true, false])(
  "shows a saved unlisted value as unavailable when custom entry is %s",
  async (allowCustomModel) => {
    const { user } = setup("claude-old-1", { allowCustomModel });
    if (allowCustomModel) expect(input()).toHaveValue("claude-old-1");
    else expect(control()).toHaveTextContent("claude-old-1");
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
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("offers a typed ID that matches nothing as a custom model", async () => {
  const { user } = setup("");
  await user.clear(input());
  await user.type(input(), "zzz-unlisted");
  const option = await screen.findByRole("option", { name: /zzz-unlisted/ });
  expect(option).toHaveTextContent("Custom model");
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
  expect(input()).toBeDisabled();
});

it("works compact, in the dialog's corner", async () => {
  const { onChange, user } = setup("sonnet", { compact: true });
  expect(input()).toHaveValue("Sonnet");
  await user.click(input());
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});
