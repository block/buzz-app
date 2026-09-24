// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityRail } from "./CommunityRail";
import type { Communities, ClientSnapshot } from "./service";

afterEach(cleanup);

it("switches using the shared membership owner without acquiring other sessions on render", () => {
  let snapshot: ClientSnapshot = {
    status: "ready",
    profile: { name: "", picture: "" },
    viewer: "a".repeat(64),
    selected: "a",
    memberships: [
      { id: "a", name: "Primary" },
      { id: "b", name: "Secondary" },
    ],
  };
  const listeners = new Set<() => void>();
  const select = vi.fn((id: string | null) => {
    snapshot = { ...snapshot, selected: id };
    for (const notify of listeners) notify();
  });
  const communities = {
    snapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    select,
  } as unknown as Communities;

  render(<CommunityRail communities={communities} />);
  expect(select).not.toHaveBeenCalled();
  expect(
    screen.getByRole("navigation", { name: "Communities" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Switch to Primary" }),
  ).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Switch to Secondary" }));
  expect(select).toHaveBeenCalledWith("b");
  expect(
    screen.getByRole("button", { name: "Switch to Secondary" }),
  ).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Personal space" }));
  expect(select).toHaveBeenCalledWith(null);
  expect(
    screen.getByRole("button", { name: "Personal space" }),
  ).toHaveAttribute("aria-current", "true");
  const add = screen.getByRole("button", { name: "Add a community" });
  fireEvent.click(add);
  expect(
    screen.getByRole("heading", { name: "Add a community" }),
  ).toBeInTheDocument();
  expect(select).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("button", { name: "Switch to Primary" }),
  ).toBeInTheDocument();

  act(() => {
    snapshot = { ...snapshot, memberships: [{ id: "b", name: "Secondary" }] };
    for (const notify of listeners) notify();
  });
  expect(
    screen.queryByRole("button", { name: "Switch to Primary" }),
  ).not.toBeInTheDocument();
});
