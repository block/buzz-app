// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { Button } from "./Button";
import { Field } from "./Field";
import { Input } from "./Input";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
} from "./Popover";

afterEach(cleanup);

test("popover composes a labelled form, preserves controlled values and closes without accidental submission", async () => {
  const user = userEvent.setup();
  const save = vi.fn();
  function Example() {
    const [value, setValue] = useState("Studio");
    return (
      <PopoverRoot>
        <PopoverTrigger render={<Button>Edit name</Button>} />
        <PopoverPopup>
          <PopoverTitle>Workspace name</PopoverTitle>
          <PopoverDescription>A name your team recognizes.</PopoverDescription>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save(value);
            }}
          >
            <Field label="Name">
              <Input value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Button type="submit">Save</Button>
            <PopoverClose render={<Button>Done</Button>} />
          </form>
        </PopoverPopup>
      </PopoverRoot>
    );
  }
  render(
    <StrictMode>
      <Example />
    </StrictMode>,
  );
  const trigger = screen.getByRole("button", { name: "Edit name" });
  await user.click(trigger);
  const popup = await screen.findByRole("dialog", { name: "Workspace name" });
  expect(popup).toHaveAccessibleDescription("A name your team recognizes.");
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Research");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledExactlyOnceWith("Research");
  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(popup).not.toBeInTheDocument());
  expect(save).toHaveBeenCalledTimes(1);
  await user.click(trigger);
  expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(
    "Research",
  );
});

test("controlled dismissal reports closing and disabled triggers stay closed", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <PopoverRoot
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            change(next);
          }}
        >
          <PopoverTrigger render={<Button>Details</Button>} />
          <PopoverPopup aria-label="Details">
            <PopoverClose render={<Button>Close</Button>} />
          </PopoverPopup>
        </PopoverRoot>
        <PopoverRoot>
          <PopoverTrigger disabled render={<Button>Unavailable</Button>} />
          <PopoverPopup aria-label="Unavailable details" />
        </PopoverRoot>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Unavailable" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Details" }));
  await user.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(change.mock.calls).toEqual([[true], [false]]);
});
