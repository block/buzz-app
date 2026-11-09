// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PanelCard } from "../panels/PanelCard";
import type { RegisteredPanel } from "../panels/service";
import { PageView } from "./PageView";
import type { RegisteredPage } from "./service";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pageThatThrows(state: { broken: boolean }): RegisteredPage {
  return {
    key: "acme.notes/home",
    pluginId: "acme.notes",
    revision: "r1",
    id: "home",
    title: "Home",
    component: () => {
      if (state.broken) throw new Error("Fixture page render failure");
      return <p>Page content</p>;
    },
  };
}

it("keeps a built-in page's raw failure in collapsed Details and offers Try again", () => {
  const state = { broken: true };
  render(<PageView page={pageThatThrows(state)} />);

  expect(screen.getByRole("alert")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "This page couldn’t open" }),
  ).toBeVisible();
  expect(
    screen.getByText("Something went wrong showing this page."),
  ).toBeVisible();
  expect(
    screen.getByText("If it keeps happening, restart Buzz."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage plugin" })).toBeNull();
  expect(screen.queryByText(/Open Settings to disable/)).toBeNull();
  // The exception text is only behind the collapsed disclosure.
  expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.queryByText(/Fixture page render failure/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("Error: Fixture page render failure")).toBeVisible();

  state.broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Page content")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("stays on the failure when Try again fails again", () => {
  render(<PageView page={pageThatThrows({ broken: true })} />);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("alert")).toBeVisible();
});

it("names an external plugin and opens its management", () => {
  const manage = vi.fn();
  const owners = vi.fn((pluginId: string) =>
    pluginId === "acme.notes" ? { name: "Acme Notes", manage } : undefined,
  );
  render(<PageView page={pageThatThrows({ broken: true })} owners={owners} />);
  expect(owners).toHaveBeenCalledWith("acme.notes");
  expect(
    screen.getByText("Acme Notes had a problem showing it."),
  ).toBeVisible();
  expect(screen.queryByText(/restart Buzz/)).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  // Secondary first, primary last, as in dialog footers and forms.
  expect(
    screen
      .getAllByRole("button", { name: /^(Manage plugin|Try again)$/ })
      .map((button) => button.textContent),
  ).toEqual(["Manage plugin", "Try again"]);
  fireEvent.click(screen.getByRole("button", { name: "Manage plugin" }));
  expect(manage).toHaveBeenCalledOnce();
});

it("keeps the built-in copy for a page whose plugin isn't external", () => {
  render(
    <PageView
      page={pageThatThrows({ broken: true })}
      owners={() => undefined}
    />,
  );
  expect(
    screen.getByText("Something went wrong showing this page."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage plugin" })).toBeNull();
});

it("lets a panel inside the page name its own plugin", () => {
  const manage = vi.fn();
  const panel = {
    key: "other.tools/side",
    pluginId: "other.tools",
    revision: "r1",
    id: "side",
    title: "Tools",
    component: () => {
      throw new Error("Fixture panel render failure");
    },
  } as unknown as RegisteredPanel;
  const page: RegisteredPage = {
    ...pageThatThrows({ broken: false }),
    component: () => (
      <PanelCard panel={panel} target="channel:alpha" close={() => {}} />
    ),
  };
  render(
    <PageView
      page={page}
      owners={(pluginId) =>
        pluginId === "other.tools" ? { name: "Other Tools", manage } : undefined
      }
    />,
  );
  expect(
    screen.getByRole("heading", { name: "This panel couldn’t open" }),
  ).toBeVisible();
  expect(
    screen.getByText("Other Tools had a problem showing it."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Manage plugin" }));
  expect(manage).toHaveBeenCalledOnce();
});
