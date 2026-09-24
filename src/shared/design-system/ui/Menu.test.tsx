// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { Button } from "./Button";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuLinkItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "./Menu";

afterEach(cleanup);

test("actions and links keep semantics, callbacks and dismissal while disabled items reject activation", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  const disabled = vi.fn();
  render(
    <StrictMode>
      <MenuRoot>
        <MenuTrigger render={<Button>Actions</Button>} />
        <MenuPopup>
          <MenuItem onClick={action}>Copy link</MenuItem>
          <MenuItem disabled onClick={disabled}>
            Unavailable
          </MenuItem>
          <MenuLinkItem href="#documentation">Documentation</MenuLinkItem>
        </MenuPopup>
      </MenuRoot>
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "Actions" }));
  const unavailable = await screen.findByRole("menuitem", {
    name: "Unavailable",
  });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await user.click(unavailable);
  unavailable.focus();
  await user.keyboard("{Enter} ");
  expect(disabled).not.toHaveBeenCalled();
  expect(
    screen.getByRole("menuitem", { name: "Documentation" }),
  ).toHaveAttribute("href", "#documentation");
  await user.click(screen.getByRole("menuitem", { name: "Copy link" }));
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

test("controlled checkbox and radio choices report selection and retain disabled values", async () => {
  const user = userEvent.setup();
  const checkboxChange = vi.fn();
  const radioChange = vi.fn();
  const disabledChange = vi.fn();
  function Example() {
    const [checked, setChecked] = useState(false);
    const [value, setValue] = useState("comfortable");
    return (
      <MenuRoot>
        <MenuTrigger render={<Button>Options</Button>} />
        <MenuPopup>
          <MenuCheckboxItem
            checked={checked}
            closeOnClick={false}
            onCheckedChange={(next) => {
              checkboxChange(next);
              setChecked(next);
            }}
          >
            Show details
          </MenuCheckboxItem>
          <MenuCheckboxItem
            disabled
            checked={false}
            onCheckedChange={disabledChange}
          >
            Unavailable toggle
          </MenuCheckboxItem>
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              radioChange(next);
              setValue(next);
            }}
          >
            <MenuRadioItem value="comfortable" closeOnClick={false}>
              Comfortable
            </MenuRadioItem>
            <MenuRadioItem value="compact" closeOnClick={false}>
              Compact
            </MenuRadioItem>
            <MenuRadioItem value="unavailable" disabled>
              Unavailable choice
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    );
  }
  render(
    <StrictMode>
      <Example />
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "Options" }));
  const checkbox = await screen.findByRole("menuitemcheckbox", {
    name: "Show details",
  });
  await user.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(checkboxChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("menuitemradio", { name: "Compact" }));
  expect(screen.getByRole("menuitemradio", { name: "Compact" })).toBeChecked();
  expect(
    screen.getByRole("menuitemradio", { name: "Comfortable" }),
  ).not.toBeChecked();
  expect(radioChange).toHaveBeenCalledExactlyOnceWith("compact");
  await user.click(
    screen.getByRole("menuitemcheckbox", { name: "Unavailable toggle" }),
  );
  await user.click(
    screen.getByRole("menuitemradio", { name: "Unavailable choice" }),
  );
  expect(disabledChange).not.toHaveBeenCalled();
  expect(radioChange).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("menuitemradio", { name: "Compact" })).toBeChecked();
});

test("context menus reuse the shared popup and action boundary", async () => {
  const action = vi.fn();
  const user = userEvent.setup();
  render(
    <StrictMode>
      <ContextMenuRoot>
        <ContextMenuTrigger>Context target</ContextMenuTrigger>
        <MenuPopup>
          <MenuItem onClick={action}>Copy context link</MenuItem>
        </MenuPopup>
      </ContextMenuRoot>
    </StrictMode>,
  );
  fireEvent.contextMenu(screen.getByText("Context target"), {
    clientX: 20,
    clientY: 20,
  });
  const item = await screen.findByRole("menuitem", {
    name: "Copy context link",
  });
  expect(screen.getByRole("menu")).toHaveAttribute("data-buzz-ui");
  await user.click(item);
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});
