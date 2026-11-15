// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RegisteredPanel } from "../../features/panels/service";
import { PanelTitleBarRows } from "./PanelLaunchers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const panel = (
  id: string,
  titleBarRow?: RegisteredPanel["titleBarRow"],
): RegisteredPanel => ({
  id,
  key: `fixture:${id}`,
  pluginId: "fixture",
  revision: "1",
  title: id,
  matches: () => false,
  ...(titleBarRow && { titleBarRow }),
  component: () => null,
});

it("renders title bar rows, isolating one that fails", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { container } = render(
    <div>
      <PanelTitleBarRows
        panels={[
          panel("plain"),
          panel("pins", () => <nav aria-label="Pinned" />),
          panel("broken", () => {
            throw new Error("broken");
          }),
        ]}
      />
    </div>,
  );
  expect(screen.getByRole("navigation", { name: "Pinned" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "broken controls unavailable",
  );
  expect(container.firstElementChild?.childElementCount).toBe(2);
});

it("leaves the row container empty while no row renders anything", () => {
  const { container } = render(
    <div>
      <PanelTitleBarRows
        panels={[panel("plain"), panel("idle", () => null)]}
      />
    </div>,
  );
  expect(container.firstElementChild).toBeEmptyDOMElement();
});
