// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PanelView } from "./PanelView";
import type { RegisteredPanel } from "./service";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function panelThatThrows(state: { broken: boolean }) {
  return {
    key: "acme.notes/side",
    pluginId: "acme.notes",
    revision: "r1",
    id: "side",
    component: () => {
      if (state.broken) throw new Error("Fixture panel render failure");
      return <p>Panel content</p>;
    },
  } as unknown as RegisteredPanel;
}

const props = { target: "channel:alpha", close: () => {} };

it("shows a built-in panel failure, keeps raw text collapsed, and recovers on Try again", () => {
  const state = { broken: true };
  render(<PanelView panel={panelThatThrows(state)} {...props} />);

  expect(
    screen.getByRole("heading", { name: "This panel couldn’t open" }),
  ).toBeVisible();
  expect(
    screen.getByText("Something went wrong showing this panel."),
  ).toBeVisible();
  expect(
    screen.getByText("If it keeps happening, restart Buzz."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage plugin" })).toBeNull();
  expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.queryByText(/Fixture panel render failure/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("Error: Fixture panel render failure")).toBeVisible();

  state.broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Panel content")).toBeVisible();
});

it("names an external plugin and opens its management", () => {
  const manage = vi.fn();
  render(
    <PanelView
      panel={panelThatThrows({ broken: true })}
      plugin={{ name: "Acme Notes", manage }}
      {...props}
    />,
  );
  expect(
    screen.getByText("Acme Notes had a problem showing it."),
  ).toBeVisible();
  // Secondary first, primary last, as in dialog footers and forms.
  expect(
    screen
      .getAllByRole("button", { name: /^(Manage plugin|Try again)$/ })
      .map((button) => button.textContent),
  ).toEqual(["Manage plugin", "Try again"]);
  fireEvent.click(screen.getByRole("button", { name: "Manage plugin" }));
  expect(manage).toHaveBeenCalledOnce();
});
