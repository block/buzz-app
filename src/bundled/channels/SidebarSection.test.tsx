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
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { SidebarSection } from "./SidebarSection";

afterEach(cleanup);
function Section() {
  const [open, setOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <SidebarSection
        title="Channels"
        open={open}
        onToggle={setOpen}
        newMessage={() => {}}
      >
        <button type="button">General</button>
      </SidebarSection>
      <button type="button" onClick={() => setRevision(revision + 1)}>
        Update {revision}
      </button>
    </>
  );
}
it("keeps section actions independent of disclosure and supports menu keyboard dismissal", async () => {
  const user = userEvent.setup();
  render(<Section />);
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
  const trigger = screen.getByRole("button", {
    name: "More options for Channels",
  });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Collapse section" }),
  );
  expect(
    screen.getByLabelText("Channels").closest("details"),
  ).not.toHaveAttribute("open");
  await user.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  await user.click(screen.getByLabelText("Channels"));
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});
it("orders header actions before section rows for keyboard navigation", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  summary.focus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "More options for Channels" }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "New message" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "General" })).toHaveFocus();
});
it("retains an expansion requested by an offscreen unread cue on subsequent renders", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  await user.click(summary);
  const details = summary.closest("details");
  if (!details) throw new Error("Missing section disclosure");
  fireEvent.click(summary);
  await user.click(screen.getByRole("button", { name: "Update 0" }));
  expect(details).toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});
