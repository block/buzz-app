// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageActionBar } from "./MessageActionBar";
import { MenuItem } from "../../shared/design-system/ui/Menu";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("replies and exposes real sibling controls without placeholders", () => {
  const reply = vi.fn();
  render(<MessageActionBar onReply={reply} copyText={() => "Hello"} />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(reply).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Copy link" }).hasAttribute("disabled"),
  ).toBe(true);
});
it("opens with keyboard, invokes a sibling action, and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(
    <MessageActionBar
      copyText={() => "Hello"}
      overflowItems={<MenuItem onClick={action}>Edit message</MenuItem>}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More message actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  expect(action).toHaveBeenCalledOnce();
  await user.click(trigger);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("copies the message, shows failure, and allows retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  render(<MessageActionBar copyText={() => "Hello"} />);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn’t copy",
  );
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  expect((await screen.findByRole("status")).textContent).toContain(
    "Message copied",
  );
  expect(write).toHaveBeenLastCalledWith("Hello");
});
it("prevents duplicate clipboard writes until the first settles", async () => {
  userEvent.setup();
  let finish!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <MessageActionBar
      link="buzz://link"
      copyText={() => "Hello"}
      replyDisabled
      onReply={() => {}}
    />,
  );
  const link = screen.getByRole("button", { name: "Copy link" });
  fireEvent.click(link);
  try {
    expect(link.hasAttribute("disabled")).toBe(true);
    fireEvent.click(link);
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
  } finally {
    finish();
  }
  await screen.findByRole("status");
  expect(link.hasAttribute("disabled")).toBe(false);
});
