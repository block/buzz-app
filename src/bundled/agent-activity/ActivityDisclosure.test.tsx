// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ActivityDisclosure } from "./ActivityDisclosure";
afterEach(cleanup);
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <ActivityDisclosure
      label="View activity"
      expanded={open}
      onExpand={setOpen}
    >
      <p>Activity contents</p>
    </ActivityDisclosure>
  );
}
it("uses one disclosure button without privacy notices", async () => {
  const user = userEvent.setup();
  const view = render(<Fixture />, { reactStrictMode: true });
  const button = screen.getByRole("button", { name: "View activity" });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(button.getAttribute("aria-description")).toBeNull();
  await user.tab();
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await user.keyboard("{Enter}");
  expect(await screen.findByText("Activity contents")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Collapse activity" }),
  ).toBeNull();
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await user.unhover(button);
  await user.hover(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  await user.keyboard(" ");
  await waitFor(() =>
    expect(screen.queryByText("Activity contents")).toBeNull(),
  );
  expect(button.getAttribute("aria-expanded")).toBe("false");
  view.unmount();
  expect(screen.queryByRole("tooltip")).toBeNull();
});
