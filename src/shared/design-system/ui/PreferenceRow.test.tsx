// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PreferenceRow } from "./PreferenceRow";

afterEach(cleanup);

it("associates its label and description with the trailing switch", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <PreferenceRow
      label="Desktop alerts"
      description="Show notifications for new activity."
      checked={false}
      onCheckedChange={change}
    />,
  );
  const control = screen.getByRole("switch", { name: "Desktop alerts" });
  expect(control).toHaveAccessibleDescription(
    "Show notifications for new activity.",
  );
  await user.click(screen.getByText("Desktop alerts"));
  expect(change).toHaveBeenCalledExactlyOnceWith(true, expect.anything());
});

it("keeps an unavailable preference named and inoperable", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <PreferenceRow
      label="Unavailable preference"
      disabled
      checked={false}
      onCheckedChange={change}
    />,
  );
  const control = screen.getByRole("switch", {
    name: "Unavailable preference",
  });
  expect(control).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByText("Unavailable preference"));
  expect(change).not.toHaveBeenCalled();
});
