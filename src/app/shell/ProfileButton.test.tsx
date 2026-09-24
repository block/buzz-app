// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../../features/communities/service";
import { ProfileButton } from "./ProfileButton";

afterEach(cleanup);

it("keeps the header cutout and menu status in sync with presence", () => {
  const listeners = new Set<() => void>();
  let presence = {
    status: "online" as "online" | "away" | "offline",
    preference: "auto",
  };
  const state = { profile: { name: "", picture: "" }, viewer: "a".repeat(64) };
  const communities = {
    subscribe: () => () => {},
    snapshot: () => state,
    presence: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => presence,
      setPreference: () => {},
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
  expect(button).toHaveAttribute("data-icon-variant", "ghost");
  expect(button.querySelector(".buzz-avatar svg")).toBeInTheDocument();
  expect(button.querySelector(".buzz-avatar")).not.toHaveTextContent("?");
  expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "online",
  );
  fireEvent.click(button);
  expect(
    screen.getByText("Active", { selector: "[data-status]" }),
  ).toHaveAttribute("data-status", "online");

  for (const [status, label] of [
    ["away", "Away"],
    ["offline", "Offline"],
  ] as const) {
    act(() => {
      presence = { ...presence, status };
      for (const listener of listeners) listener();
    });
    expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      status,
    );
    expect(
      screen.getByText(label, { selector: "[data-status]" }),
    ).toHaveAttribute("data-status", status);
  }
});

it.each([false, true])(
  "hands Settings focus over after closing without stealing early page focus (%s)",
  async (earlyFocus) => {
    const user = userEvent.setup();
    const snapshot = {
      profile: { name: "Fixture", picture: "" },
      viewer: null,
    };
    const presence = { status: "online", preference: "auto", error: null };
    const subscribe = () => () => {};
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
    } as unknown as Communities;
    function Shell() {
      const [settings, setSettings] = useState(false);
      return (
        <>
          <ProfileButton
            communities={communities}
            settingsSelected={settings}
            onSettings={() => setSettings(true)}
          />
          <main id="main-content" tabIndex={-1}>
            {settings && <input aria-label="Display name" />}
          </main>
        </>
      );
    }
    render(<Shell />);
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    const menu = await screen.findByRole("menu", { name: "Your account" });
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const animations = vi.fn(() => [{ finished }]);
    // Hold the real menu's close-completion boundary, not a guessed delay or
    // a replacement React lifecycle. The production callback runs on release.
    Object.defineProperty(menu, "getAnimations", { value: animations });
    try {
      await user.click(screen.getByRole("menuitem", { name: "Settings" }));
      await waitFor(() => expect(animations).toHaveBeenCalled());
      expect(menu).toBeInTheDocument();
      const input = screen.getByRole("textbox", { name: "Display name" });
      if (earlyFocus) await user.type(input, "Do not save");
      await act(async () => release());
      await waitFor(() => expect(menu).not.toBeInTheDocument());
      expect(earlyFocus ? input : screen.getByRole("main")).toHaveFocus();
      if (earlyFocus) expect(input).toHaveValue("Do not save");
    } finally {
      await act(async () => release());
    }
  },
);
