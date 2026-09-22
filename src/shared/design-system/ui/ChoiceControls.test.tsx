// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./Select";
import { Combobox } from "./Combobox";

afterEach(cleanup);
const options = [
  { value: "one", label: "One" },
  { value: "two", label: "Two" },
];

it("selects a form option with the keyboard and restores trigger focus", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("one");
    return (
      <Select
        label="Choice"
        variant="field"
        value={value}
        groups={[{ label: "", options }]}
        onValueChange={setValue}
      />
    );
  }
  render(<Example />);
  const trigger = screen.getByRole("combobox", { name: "Choice" });
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("option", { name: "Two" });
  await user.keyboard("{End}{Enter}");
  expect(trigger).toHaveTextContent("Two");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("disables both form choices and searchable input/browse controls", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const browse = vi.fn();
  render(
    <>
      <Select
        label="Choice"
        variant="field"
        disabled
        value="one"
        groups={[{ label: "", options }]}
        onValueChange={change}
      />
      <Combobox.Root items={options} disabled onValueChange={change}>
        <Combobox.Control
          label="Search"
          triggerLabel="Browse choices"
          onBrowse={browse}
        />
        <Combobox.Popup empty="No choices">
          <Combobox.List>
            {(item: (typeof options)[number]) => (
              <Combobox.Item value={item} key={item.value}>
                {item.label}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </>,
  );
  expect(screen.getByRole("combobox", { name: "Choice" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Search" })).toBeDisabled();
  const trigger = screen.getByRole("button", { name: "Browse choices" });
  expect(trigger).toBeDisabled();
  await user.click(trigger);
  expect(browse).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("filters and selects through the real shared combobox", async () => {
  const user = userEvent.setup();
  render(
    <Combobox.Root items={options}>
      <Combobox.Control label="Search" triggerLabel="Browse choices" />
      <Combobox.Popup empty="No choices">
        <Combobox.List>
          {(item: (typeof options)[number]) => (
            <Combobox.Item value={item} key={item.value}>
              {item.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>,
  );
  const input = screen.getByRole("combobox", { name: "Search" });
  await user.type(input, "Two");
  await user.click(await screen.findByRole("option", { name: "Two" }));
  expect(input).toHaveValue("Two");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
