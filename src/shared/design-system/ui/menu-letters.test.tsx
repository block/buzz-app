// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "./Menu";
import { assignMenuLetters, enableMenuLetters } from "./menu-letters";

afterEach(cleanup);

/** Base UI moves focus into an opened menu a frame later; keys go there. */
const menuFocused = () =>
  waitFor(() =>
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull(),
  );

test("letters come from labels, keep fixed keys and never repeat", () => {
  expect(
    assignMenuLetters([
      { label: "Reply" },
      { label: "Copy message" },
      { label: "Copy link" },
      { label: "Forward message" },
      { label: "Search", fixed: "c" },
      { label: "Ccc" },
    ]),
  ).toEqual(["r", "m", "l", "f", "c", undefined]);
  expect(
    assignMenuLetters([{ label: "Mute" }, { label: "Mark read" }]),
  ).toEqual(["m", "r"]);
  // Reserved keys stay with whoever turned letters on.
  expect(assignMenuLetters([{ label: "Copy link" }], "cl")).toEqual(["o"]);
});

function Actions({ onReply, onEdit }: { onReply(): void; onEdit(): void }) {
  return (
    <MenuRoot>
      <MenuTrigger>Actions</MenuTrigger>
      <MenuPopup>
        <MenuItem onClick={onReply}>Reply</MenuItem>
        <MenuItem disabled onClick={onEdit}>
          Edit
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
}

test("while letters are on, items show and run their key; off, nothing changes", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn();
  const onEdit = vi.fn();
  render(<Actions onReply={onReply} onEdit={onEdit} />);

  await user.click(screen.getByRole("button", { name: "Actions" }));
  const reply = await screen.findByRole("menuitem", { name: "Reply" });
  expect(reply).not.toHaveAttribute("aria-keyshortcuts");
  await menuFocused();
  await user.keyboard("r");
  expect(onReply).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");

  let release = () => {};
  act(() => {
    release = enableMenuLetters();
  });
  await user.click(screen.getByRole("button", { name: "Actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Reply" }),
  ).toHaveAttribute("aria-keyshortcuts", "r");
  expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
    "data-menu-letter",
    "e",
  );
  await menuFocused();
  // A disabled item keeps its key; pressing it neither runs it nor falls through.
  const outside = vi.fn();
  document.addEventListener("keydown", outside);
  await user.keyboard("e");
  document.removeEventListener("keydown", outside);
  expect(outside).not.toHaveBeenCalled();
  expect(onEdit).not.toHaveBeenCalled();
  await user.keyboard("r");
  expect(onReply).toHaveBeenCalledTimes(1);

  act(release);
  await user.click(screen.getByRole("button", { name: "Actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Reply" }),
  ).not.toHaveAttribute("aria-keyshortcuts");
});

test("a key in a submenu runs the submenu's item, not the parent's", async () => {
  const user = userEvent.setup();
  const status = vi.fn();
  const system = vi.fn();
  const release = enableMenuLetters();
  try {
    render(
      <MenuRoot>
        <MenuTrigger>Profile</MenuTrigger>
        <MenuPopup>
          <MenuItem onClick={status}>Set a status</MenuItem>
          <MenuSubmenu>
            <MenuSubmenuTrigger>Appearance</MenuSubmenuTrigger>
            <MenuSubmenuPopup>
              <MenuItem onClick={system}>System</MenuItem>
            </MenuSubmenuPopup>
          </MenuSubmenu>
        </MenuPopup>
      </MenuRoot>,
    );
    await user.click(screen.getByRole("button", { name: "Profile" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Appearance" }),
    );
    const item = await screen.findByRole("menuitem", { name: "System" });
    expect(item).toHaveAttribute("aria-keyshortcuts", "s");
    item.focus();
    await user.keyboard("s");
    expect(system).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  } finally {
    act(release);
  }
});

test("a caller's own capture handler still sees every key first", async () => {
  const user = userEvent.setup();
  const own = vi.fn();
  const reply = vi.fn();
  const release = enableMenuLetters();
  try {
    render(
      <MenuRoot>
        <MenuTrigger>Actions</MenuTrigger>
        <MenuPopup onKeyDownCapture={(event) => own(event.key)}>
          <MenuItem onClick={reply}>Reply</MenuItem>
        </MenuPopup>
      </MenuRoot>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("menuitem", { name: "Reply" });
    await menuFocused();
    await user.keyboard("r");
    expect(own).toHaveBeenCalledWith("r");
    expect(reply).toHaveBeenCalledTimes(1);
  } finally {
    act(release);
  }
});
