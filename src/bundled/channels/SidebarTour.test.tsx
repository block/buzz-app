// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { readView, writeView } from "../../shared/view-state";
import {
  SidebarTour,
  sidebarTourEdition,
  sidebarTourPages,
} from "./SidebarTour";

const firstTitle = "Workspaces hold anything";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function mount(ready = true) {
  const aside = document.createElement("aside");
  const list = document.createElement("div");
  aside.append(list);
  document.body.append(aside);
  const listRef = createRef<HTMLElement | null>() as {
    current: HTMLElement | null;
  };
  listRef.current = list;
  return render(<SidebarTour listRef={listRef} ready={ready} />);
}

test("sidebar tour waits for the layout, then shows its four pages in order", async () => {
  const user = userEvent.setup();
  const view = mount(false);
  expect(screen.queryByText(firstTitle)).toBeNull();
  view.unmount();
  mount();
  for (const page of sidebarTourPages.slice(0, -1)) {
    expect(screen.getByText(page.title)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
  }
  expect(screen.getByText("Reorder workspaces")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Got it" }));
  expect(screen.queryByText("Reorder workspaces")).toBeNull();
  expect(readView("device", "sidebar:tour-seen", null)).toBe(
    sidebarTourEdition,
  );
});

test("sidebar tour stays away once seen on this device", () => {
  writeView("device", "sidebar:tour-seen", sidebarTourEdition);
  mount();
  expect(screen.queryByText(firstTitle)).toBeNull();
});

test("closing the sidebar tour also counts as seen", async () => {
  const user = userEvent.setup();
  mount();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText(firstTitle)).toBeNull();
  expect(readView("device", "sidebar:tour-seen", null)).toBe(
    sidebarTourEdition,
  );
});
