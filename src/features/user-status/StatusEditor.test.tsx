// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { UserStatus } from "../relay/user-status";
import { StatusEditor } from "./StatusEditor";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});
function setup(current?: UserStatus) {
  const owner = createRelaySession(null);
  owners.push(owner);
  const save = vi.fn(async () => {});
  const close = vi.fn();
  const session = {
    ...owner.session,
    statuses: { ...owner.session.statuses, save },
  };
  render(
    <StatusEditor
      session={session}
      scope="https://status.test"
      current={current}
      close={close}
      finalFocus={{ current: null }}
    />,
  );
  return { save, close };
}
it("calculates the selected preset at save time after a quick choice is edited", async () => {
  const user = userEvent.setup();
  let now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { save, close } = setup();
  await user.click(screen.getByRole("button", { name: "In a meeting" }));
  fireEvent.change(screen.getByLabelText("Status message"), {
    target: { value: "Design review" },
  });
  await user.click(screen.getByRole("button", { name: "Duration: Today" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "8 hours" }),
  );
  now += 600_000;
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({
    text: "Design review",
    emoji: "🗣️",
    expiresAt: now / 1000 + 28800,
  });
});
it("prefills and preserves an existing deadline, and validates a custom date before saving", async () => {
  const user = userEvent.setup();
  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + 86400;
  const { save } = setup({
    userId: "a".repeat(64),
    text: "Remote",
    emoji: "🏠",
    updatedAt: now / 1000,
    expiresAt,
  });
  expect(screen.getByLabelText("Status message")).toHaveValue("Remote");
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      text: "Remote",
      emoji: "🏠",
      expiresAt,
    }),
  );
  await user.click(screen.getByRole("button", { name: /^Duration:/ }));
  await user.click(
    await screen.findByRole("menuitemradio", {
      name: "Custom",
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Status expiration time" }),
  );
  const options = await screen.findAllByRole("menuitemradio");
  expect(options).toHaveLength(48);
  expect(options[0]).toHaveTextContent("12:00 AM");
  expect(options[47]).toHaveTextContent("11:30 PM");
  await user.click(screen.getByRole("menuitemradio", { name: "12:00 AM" }));
  await user.click(
    screen.getByRole("button", { name: "Status expiration date" }),
  );
  await user.click(await screen.findByRole("button", { name: /^Today,/ }));
  await user.click(screen.getByRole("button", { name: "Save status" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a date and time in the future.",
  );
  expect(save).toHaveBeenCalledOnce();
  await user.click(
    screen.getByRole("button", { name: "Status expiration date" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Today,/ })).toHaveFocus(),
  );
  await user.keyboard("{ArrowRight}{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Status expiration date" }),
    ).toHaveFocus(),
  );
  expect(
    screen.getByRole("button", { name: "Status expiration time" }),
  ).toHaveTextContent("12:00 AM");
  await user.click(
    screen.getByRole("button", { name: "Status expiration time" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "11:30 PM" }),
  );
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 30, 0, 0);
  expect(save).toHaveBeenLastCalledWith({
    text: "Remote",
    emoji: "🏠",
    expiresAt: tomorrow.getTime() / 1000,
  });
});
