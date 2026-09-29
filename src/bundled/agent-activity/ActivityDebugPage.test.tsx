// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubPopoverBrowserApis } from "./popover-testing";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import ActivityDebugPage from "./ActivityDebugPage";

stubPopoverBrowserApis();
afterEach(() => {
  cleanup();
});
vi.mock("../../features/messages/MessageComposer", () => ({
  MessageComposer: () => null,
}));
vi.mock("../../features/messages/use-reading", () => ({
  useReading: () => {},
}));
it("cycles working, complete and reset without retaining the generated reply", async () => {
  render(<ActivityDebugPage />);
  const working = await screen.findByRole("button", { name: "Working" });
  const reply =
    "I've checked the latest copy. The onboarding steps read clearly now.";
  expect(
    await screen.findAllByRole("img", { name: "Agent, online" }),
  ).toHaveLength(1);
  fireEvent.click(working);
  expect(
    screen.getByRole("img", { name: "Buzzy avatar, online" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(screen.getByText(reply)).toBeVisible();
  expect(screen.getAllByRole("img", { name: "Agent, online" })).toHaveLength(2);
  expect(
    screen.queryByRole("img", { name: "Buzzy avatar, online" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.queryByText(reply)).toBeNull();
  expect(screen.getAllByRole("img", { name: "Agent, online" })).toHaveLength(1);
  expect(
    screen.queryByRole("region", { name: "Agent activity in this thread" }),
  ).toBeNull();
  fireEvent.click(working);
  expect(
    screen.getByRole("img", { name: "Buzzy avatar, online" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(
    screen.queryByRole("region", { name: "Agent activity in this thread" }),
  ).toBeNull();
});

it("opens from working text, dismisses the popover and clears it on completion", async () => {
  const user = userEvent.setup();
  render(<ActivityDebugPage />);
  await user.click(await screen.findByRole("button", { name: "Working" }));
  expect(
    screen.getByRole("img", { name: "Buzzy avatar, online" }),
  ).toBeVisible();
  expect(screen.queryByRole("img", { name: /thinking/ })).toBeNull();
  const indicator = screen.getByRole("button", {
    name: /Buzzy Reading/,
  });
  await user.click(indicator);
  expect(await screen.findByRole("dialog", { name: "Buzzy" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(indicator).toHaveFocus();
  await user.click(indicator);
  await user.click(screen.getByRole("button", { name: "Close activity" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(indicator);
  await user.click(screen.getByRole("button", { name: "Complete" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /Buzzy Reading/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Working" }));
  expect(
    screen.getByRole("img", { name: "Buzzy avatar, online" }),
  ).toBeVisible();
});

it("expands from the popover into the dedicated activity stream", async () => {
  const user = userEvent.setup();
  render(<ActivityDebugPage />);
  await user.click(await screen.findByRole("button", { name: "Working" }));
  await user.click(screen.getByRole("button", { name: /Buzzy Reading/ }));
  await user.click(
    screen.getByRole("button", { name: "Open activity in panel" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByRole("complementary", { name: "Dedicated activity panel" }),
  ).toBeVisible();
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "Close activity panel" }),
  );
  expect(
    screen.queryByRole("complementary", { name: "Dedicated activity panel" }),
  ).toBeNull();
});
