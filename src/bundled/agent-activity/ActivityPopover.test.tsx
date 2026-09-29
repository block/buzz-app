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
import { useState } from "react";
import { ActivityPopover } from "./ActivityPopover";
import { stubPopoverBrowserApis } from "./popover-testing";

stubPopoverBrowserApis();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Fixture({ transfer = false }: { transfer?: boolean }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState(false);
  return (
    <>
      <input aria-label="Draft" />
      <ActivityPopover
        name="Rivet"
        label="Working…"
        working
        open={open}
        onOpenChange={setOpen}
        finalFocus={() => !panel}
        onExpand={
          transfer
            ? () => {
                setPanel(true);
                setOpen(false);
              }
            : undefined
        }
      >
        <p>Exact activity details</p>
      </ActivityPopover>
      {panel && <section aria-label="Side panel">Expanded</section>}
    </>
  );
}
it("mounts details only while opened and returns keyboard dismissal to its trigger", async () => {
  const user = userEvent.setup();
  render(<Fixture />, { reactStrictMode: true });
  expect(screen.queryByText("Exact activity details")).toBeNull();
  const trigger = screen.getByRole("button", { name: "Working…" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "Rivet" })).toBeVisible();
  expect(screen.getByText("Exact activity details")).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByText("Exact activity details")).toBeNull(),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
});
it("transfers to the existing panel and unmounts the popup", async () => {
  render(<Fixture transfer />);
  fireEvent.click(screen.getByRole("button", { name: "Working…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Open activity in panel" }),
  );
  expect(screen.getByRole("region", { name: "Side panel" })).toBeVisible();
  await waitFor(() =>
    expect(screen.queryByText("Exact activity details")).toBeNull(),
  );
});
