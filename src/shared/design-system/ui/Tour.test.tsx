// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tour, type TourPage } from "./Tour";

afterEach(cleanup);

const pages: TourPage[] = [
  { id: "one", title: "First idea", description: "One.", visual: <i /> },
  { id: "two", title: "Second idea", description: "Two.", visual: <i /> },
];

function setup() {
  const anchor = document.createElement("aside");
  document.body.append(anchor);
  const dismiss = vi.fn();
  const outside = document.createElement("button");
  outside.textContent = "Elsewhere";
  document.body.append(outside);
  render(
    <Tour
      open
      label="What’s new"
      pages={pages}
      anchor={anchor}
      onDismiss={dismiss}
    />,
  );
  return { dismiss, outside };
}

test("tour pages forward and back, then finishes on its last page", async () => {
  const user = userEvent.setup();
  const { dismiss } = setup();
  expect(screen.getByText("First idea")).toBeInTheDocument();
  expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Second idea")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByText("First idea")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Got it" }));
  expect(dismiss).toHaveBeenCalledWith("finished");
});

test("tour leaves focus alone, survives outside clicks and closes on demand", async () => {
  const user = userEvent.setup();
  const { dismiss, outside } = setup();
  expect(
    screen.getByRole("dialog", { name: "What’s new" }),
  ).not.toContainElement(document.activeElement as HTMLElement);
  await user.click(outside);
  expect(dismiss).not.toHaveBeenCalled();
  expect(screen.getByText("First idea")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(dismiss).toHaveBeenCalledWith("dismissed");
});

test("arrow keys page while focus is inside the tour", async () => {
  const user = userEvent.setup();
  setup();
  screen.getByRole("button", { name: "Next" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByText("Second idea")).toBeInTheDocument();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByText("First idea")).toBeInTheDocument();
});
