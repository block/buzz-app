// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../../features/communities/service";
import { ProfileButton } from "./ProfileButton";

afterEach(cleanup);

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

it.each(["online", "away", "offline"] as const)(
  "shares %s presence between trigger and account menu",
  async (status) => {
    const user = userEvent.setup();
    const snapshot = {
      profile: { name: "Fixture", picture: "" },
      viewer: "fixture",
    };
    const presence = { status, preference: "auto", error: null };
    const subscribe = () => () => {};
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
    } as unknown as Communities;
    render(
      <ProfileButton
        communities={communities}
        settingsSelected={false}
        onSettings={() => {}}
      />,
    );
    const label = `Your status: ${{ online: "Active", away: "Away", offline: "Offline" }[status]}`;
    expect(screen.getAllByRole("img", { name: label })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    expect(
      within(
        await screen.findByRole("menu", { name: "Your account" }),
      ).getByRole("img", { name: label }),
    ).toBeVisible();
  },
);
