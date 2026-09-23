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
] as const;

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

it("connects Select errors and help to the trigger and submits its named value", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Example">
      <Select
        label="Destination"
        variant="field"
        name="destination"
        value="one"
        groups={[{ label: "", options }]}
        description="Choose a workspace."
        error="That workspace is unavailable."
        onValueChange={() => {}}
      />
    </form>,
  );
  const input = screen.getByRole("combobox", { name: "Destination" });
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription(
    /Choose a workspace.*That workspace is unavailable/,
  );
  expect(
    new FormData(screen.getByRole("form") as HTMLFormElement).get(
      "destination",
    ),
  ).toBe("one");
  await user.click(screen.getByText("Destination", { exact: true }));
  expect(input).toHaveFocus();
});

it("connects Combobox help and errors without duplicating its label", async () => {
  const user = userEvent.setup();
  render(
    <Combobox.Root items={options}>
      <Combobox.Control
        label="Search"
        triggerLabel="Browse choices"
        description="Search available choices."
        error="Choose an available item."
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
    </Combobox.Root>,
  );
  const input = screen.getByRole("combobox", { name: "Search" });
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription(
    /Search available choices.*Choose an available item/,
  );
  await user.click(screen.getByText("Search", { exact: true }));
  expect(input).toHaveFocus();
});

it("read-only and disabled options cannot change the selected value", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <>
      <Select
        label="Read-only"
        variant="field"
        readOnly
        value="one"
        groups={[{ label: "", options }]}
        onValueChange={change}
      />
      <Select
        label="With unavailable option"
        variant="field"
        value="one"
        groups={[
          {
            label: "",
            options: [options[0], { ...options[1], disabled: true }],
          },
        ]}
        onValueChange={change}
      />
      <Combobox.Root
        items={options}
        readOnly
        defaultValue={options[0]}
        onValueChange={change}
      >
        <Combobox.Control
          label="Read-only search"
          triggerLabel="Browse read-only"
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
  await user.click(screen.getByRole("combobox", { name: "Read-only" }));
  await user.click(await screen.findByRole("option", { name: "Two" }));
  expect(screen.getByRole("combobox", { name: "Read-only" })).toHaveTextContent(
    "One",
  );
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  const search = screen.getByRole("combobox", { name: "Read-only search" });
  await user.type(search, "Two");
  expect(search).toHaveValue("One");
  await user.click(await screen.findByRole("option", { name: "Two" }));
  expect(search).toHaveValue("One");
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("combobox", { name: "With unavailable option" }),
  );
  const unavailable = await screen.findByRole("option", { name: "Two" });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await user.click(unavailable);
  expect(change).not.toHaveBeenCalled();
});
