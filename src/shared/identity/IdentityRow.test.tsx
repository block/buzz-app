// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../design-system/ui/Toast";
import { IdentityRow } from "./IdentityRow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const pubkey = "ab".repeat(32);

it("previews on hover and shows a copy of the full npub in its button, with no toast", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    <ToastProvider>
      <IdentityRow pubkey={pubkey} name="Agent" isAgent />
    </ToastProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Preview Agent identity",
  });
  expect(trigger).toHaveAccessibleDescription(
    /Identity preview opens on focus/,
  );
  expect(trigger).not.toHaveAttribute("aria-details");
  await user.hover(trigger);
  const card = await screen.findByRole("dialog", { name: "Agent identity" });
  expect(card).toHaveTextContent(npubEncode(pubkey));
  expect(trigger).toHaveAttribute("aria-details", card.id);
  const copy = screen.getByRole("button", { name: "Copy npub" });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(copy));
  expect(write).toHaveBeenCalledExactlyOnceWith(npubEncode(pubkey));
  expect(copy.querySelector(".tabler-icon-check")).not.toBeNull();
  expect(copy).toHaveAccessibleName("Copy npub");
  expect(within(card).getByRole("status")).toHaveTextContent(/^Copied$/);

  act(() => vi.advanceTimersByTime(1499));
  expect(copy.querySelector(".tabler-icon-check")).not.toBeNull();
  // The clock a toast mounts on has run: the status is all that says so.
  expect(screen.getAllByText(/copied/i)).toHaveLength(1);
  expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(copy.querySelector(".tabler-icon-copy")).not.toBeNull();
  expect(within(card).getByRole("status")).toBeEmptyDOMElement();
});

it("reports clipboard denial and leaves the full key available for manual copy", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  render(
    <ToastProvider>
      <IdentityRow pubkey={pubkey} name="Morgan" />
    </ToastProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Preview Morgan identity",
  });
  expect(trigger).toHaveAccessibleDescription(/Tab to reach Copy npub/);
  expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.tab();
  expect(trigger).toHaveFocus();
  const card = await screen.findByRole("dialog", { name: "Morgan identity" });
  expect(trigger).toHaveAttribute("aria-details", card.id);
  expect(trigger).toHaveAttribute("aria-controls", card.id);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const copy = screen.getByRole("button", { name: "Copy npub" });
  await user.click(copy);
  expect(
    await screen.findByText("Couldn’t copy npub. Select the text to copy it."),
  ).toBeVisible();
  expect(card).toHaveTextContent(npubEncode(pubkey));
  // The toast reports it: the button and its status say nothing.
  expect(copy.querySelector(".tabler-icon-copy")).not.toBeNull();
  expect(within(card).getByRole("status")).toBeEmptyDOMElement();
});

beforeEach(() => {
  // jsdom hides [popover] but has no native top layer. Browser tests own paint.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});
