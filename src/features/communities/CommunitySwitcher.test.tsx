// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunitySwitcher } from "./CommunitySwitcher";
import type { ClientSnapshot, Communities } from "./service";

afterEach(cleanup);

it("recovers community artwork after failure and preserves named selection", async () => {
  let state: ClientSnapshot = {
    status: "ready",
    profile: { name: "Alex", picture: "" },
    selected: null,
    memberships: [
      { id: "studio", name: "Design studio", icon: "/failed.png" },
      { id: "team", name: "Product team" },
    ],
  };
  const communities: Communities = {
    snapshot: () => state,
    subscribe: () => () => {},
    select: vi.fn(),
    saveProfile: vi.fn(),
    joined: vi.fn(),
    relay: {
      snapshot: () => {
        throw new Error("The chooser must not read a relay snapshot");
      },
      subscribe: () => () => {},
      retry: vi.fn(),
      disconnect: vi.fn(),
      clearCache: vi.fn(async () => {}),
    },
  };
  const user = userEvent.setup();
  const view = render(<CommunitySwitcher communities={communities} />);
  await user.click(screen.getByRole("button", { name: "Switch community" }));
  const dialog = screen.getByRole("dialog", { name: "Communities" });
  const row = within(dialog).getByRole("button", {
    name: "Switch to Design studio",
  });
  const fallbackRow = within(dialog).getByRole("button", {
    name: "Switch to Product team",
  });
  expect(
    within(fallbackRow).getByText("P", { exact: true }),
  ).toBeInTheDocument();
  const artwork = row.querySelector("img");
  if (!artwork) throw new Error("Expected the community artwork");
  expect(artwork).toHaveAttribute("referrerpolicy", "no-referrer");
  fireEvent.error(artwork);
  expect(row.querySelector("img")).toBeNull();
  expect(within(row).getByText("D", { exact: true })).toBeInTheDocument();
  expect(row).toHaveAccessibleName("Switch to Design studio");

  state = {
    ...state,
    memberships: [
      { id: "studio", name: "Design studio", icon: "/replacement.png" },
    ],
  };
  view.rerender(<CommunitySwitcher communities={communities} />);
  const replacement = row.querySelector("img");
  if (!replacement) throw new Error("Expected replacement community artwork");
  expect(replacement).toHaveAttribute("src", "/replacement.png");
  fireEvent.load(replacement);
  expect(replacement).toHaveAttribute("data-loaded", "true");
  expect(within(row).queryByText("D", { exact: true })).not.toBeInTheDocument();
  await user.click(row);
  expect(communities.select).toHaveBeenCalledWith("studio");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
