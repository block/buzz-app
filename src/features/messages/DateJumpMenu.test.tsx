// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DateJumpContext } from "./DateJumpMenu";
import { dayStart, jumpStart } from "./date-jump";
import { DayDivider } from "./MessageTimestamp";

const NOW = new Date(2026, 9, 30, 15);
const today = NOW.getTime() / 1000 - 6 * 3600;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function divider(jump = vi.fn()) {
  render(
    <DateJumpContext value={jump}>
      <DayDivider createdAt={today} />
    </DateJumpContext>,
  );
  return jump;
}

it("renders a plain label without a jump context", () => {
  render(<DayDivider createdAt={today} />);
  expect(screen.getByText("Today")).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
});

it("names the trigger after its day and announces a menu", () => {
  divider();
  const trigger = screen.getByRole("button", { name: "Today, jump to date" });
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");
});

it("lists the destinations under a Jump to… heading", async () => {
  const user = userEvent.setup();
  divider();
  await user.click(screen.getByRole("button", { name: "Today, jump to date" }));
  const menu = await screen.findByRole("menu");
  expect(menu).toHaveTextContent("Jump to…");
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual([
    "Today",
    "Yesterday",
    "Last week",
    "Last month",
    "The very beginning",
    "Jump to a specific date",
  ]);
  expect(screen.queryByRole("menuitem", { name: "Jump to…" })).toBeNull();
  expect(screen.getByRole("separator")).toBeInTheDocument();
});

it("jumps to the start of a chosen destination", async () => {
  const user = userEvent.setup();
  const jump = divider();
  await user.click(screen.getByRole("button", { name: "Today, jump to date" }));
  await user.click(await screen.findByRole("menuitem", { name: "Yesterday" }));
  expect(jump).toHaveBeenCalledExactlyOnceWith(jumpStart("yesterday", NOW));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("jumps to a past day picked in the calendar", async () => {
  const user = userEvent.setup();
  const jump = divider();
  await user.click(screen.getByRole("button", { name: "Today, jump to date" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Jump to a specific date" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Jump to a specific date",
  });
  const day = (iso: string) =>
    dialog.querySelector<HTMLButtonElement>(`[data-day="${iso}"] button`);
  await waitFor(() => expect(day("2026-10-30")).toHaveFocus());
  expect(day("2026-10-31")).toBeDisabled();
  const picked = day("2026-10-12");
  expect(picked).not.toBeNull();
  await user.click(picked as HTMLButtonElement);
  expect(jump).toHaveBeenCalledExactlyOnceWith(dayStart(new Date(2026, 9, 12)));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("works by keyboard and returns focus on Escape", async () => {
  const user = userEvent.setup();
  divider();
  const trigger = screen.getByRole("button", { name: "Today, jump to date" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await user.keyboard("{End}");
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "Jump to a specific date" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{ArrowUp}");
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "The very beginning" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(trigger).toHaveFocus();
});
