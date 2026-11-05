// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RegisteredPanel } from "../../features/panels/service";
import { PanelLaunchers } from "./PanelLaunchers";

afterEach(() => {
  cleanup();
});

const icon = "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E";
const panel = (badge?: ComponentType): RegisteredPanel => ({
  key: "agent-wip:panel",
  pluginId: "agent-wip",
  revision: "one",
  id: "panel",
  title: "Agent WIP",
  matches: () => false,
  launcher: badge ? { icon, target: "", badge } : { icon, target: "" },
  component: () => null,
});

it("renders a launcher's badge as a corner mark without renaming the button", () => {
  const launch = vi.fn();
  const { container } = render(
    <PanelLaunchers
      panels={[panel(() => <span>3</span>)]}
      selected={undefined}
      launch={launch}
    />,
  );
  const button = screen.getByRole("button", { name: "Agent WIP" });
  const badge = container.querySelector(
    ".shell-toolbar-launcher > .shell-toolbar-badge",
  );
  expect(badge).toHaveTextContent("3");
  expect(button).not.toContainElement(badge as HTMLElement);
  fireEvent.click(button);
  expect(launch).toHaveBeenCalledTimes(1);
});

it("keeps the launcher usable when its badge throws", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const launch = vi.fn();
  const { container } = render(
    <PanelLaunchers
      panels={[
        panel(() => {
          throw new Error("badge failed");
        }),
      ]}
      selected={undefined}
      launch={launch}
    />,
  );
  expect(container.querySelector(".shell-toolbar-badge")).toBeEmptyDOMElement();
  fireEvent.click(screen.getByRole("button", { name: "Agent WIP" }));
  expect(launch).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});

it("leaves a launcher without a badge unwrapped", () => {
  const { container } = render(
    <PanelLaunchers panels={[panel()]} selected={undefined} launch={vi.fn()} />,
  );
  expect(container.querySelector(".shell-toolbar-launcher")).toBeNull();
  expect(container.firstElementChild).toBe(
    screen.getByRole("button", { name: "Agent WIP" }),
  );
});
