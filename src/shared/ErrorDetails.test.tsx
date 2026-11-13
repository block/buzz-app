// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorDetails } from "./ErrorDetails";

afterEach(cleanup);

test("keeps raw failure text collapsed under Details", async () => {
  render(<ErrorDetails details="ReadError: Relay read failed (502)" />);
  const trigger = screen.getByRole("button", { name: "Details" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByText("ReadError: Relay read failed (502)"),
  ).not.toBeInTheDocument();
  await userEvent.click(trigger);
  expect(screen.getByText("ReadError: Relay read failed (502)")).toBeVisible();
});

test("renders nothing without raw text", () => {
  const { container } = render(<ErrorDetails />);
  expect(container).toBeEmptyDOMElement();
});
