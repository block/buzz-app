// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Communities } from "../../features/communities/service";
import type { PresenceStatus } from "../../features/presence/presence";
import { ProfileButton } from "./ProfileButton";

afterEach(cleanup);

it("keeps the account avatar and popover status in sync", () => {
  let status: PresenceStatus = "unknown";
  const listeners = new Set<() => void>();
  const viewer = "a".repeat(64);
  const session = {
    presence: {
      status: () => status,
      subscribe: (_key: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const connection = { status: "ready", viewer, session };
  const client = { profile: { name: "Viewer", picture: "" } };
  const communities = {
    subscribe: () => () => {},
    snapshot: () => client,
    relay: {
      subscribe: () => () => {},
      snapshot: () => connection,
    },
  } as unknown as Communities;

  render(
    <ProfileButton
      communities={communities}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  const button = screen.getByRole("button", { name: "Your profile" });
  expect(button.querySelector(".buzz-avatar-status")).toBeNull();
  fireEvent.click(button);
  expect(screen.getByText("Status unavailable")).toBeVisible();

  for (const [next, label, color, textColor] of [
    ["online", "Online", "var(--status-online)", "var(--text-success)"],
    ["away", "Away", "var(--status-away)", "var(--text-warning)"],
    ["offline", "Offline", "var(--status-offline)", "var(--text-subtle)"],
  ] as const) {
    act(() => {
      status = next;
      for (const listener of listeners) listener();
    });
    expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      next,
    );
    const text = screen.getByText(label);
    expect(text).toBeVisible();
    expect(text.getAttribute("style")).toContain(textColor);
    expect(text.querySelector("span")?.getAttribute("style")).toContain(color);
  }

  act(() => {
    status = "unknown";
    for (const listener of listeners) listener();
  });
  expect(button.querySelector(".buzz-avatar-status")).toBeNull();
  expect(screen.getByText("Status unavailable")).toBeVisible();
});
