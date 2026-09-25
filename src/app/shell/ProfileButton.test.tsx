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
  const connection = { status: "unavailable", session: undefined, scope: "" };
  const subscribe = () => () => {};
  const communities = {
    subscribe,
    snapshot: () => state,
    relay: { subscribe, snapshot: () => connection },
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
  expect(button).toHaveAttribute("data-icon-variant", "chrome");
  expect(button.querySelector(".buzz-avatar svg")).toBeInTheDocument();
  expect(button.querySelector(".buzz-avatar")).not.toHaveTextContent("?");
  expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "online",
  );
  fireEvent.click(button);
  expect(
    screen.getByText("Online", { selector: "[data-status]" }),
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
    const connection = { status: "unavailable", session: undefined, scope: "" };
    const presence = { status: "online", preference: "auto", error: null };
    const subscribe = () => () => {};
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
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
    const menu = await screen.findByRole("menu", { name: "Fixture" });
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

it("shows the selected community name and authenticated avatar without saving a local default", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const owner = createRelaySession(null);
  const user = userEvent.setup();
  const viewer = "a".repeat(64);
  let profiles = new Map<string, { name: string; picture?: string }>();
  const listeners = new Set<() => void>();
  const media = vi.fn(
    (url: string) => `/community-media?url=${encodeURIComponent(url)}`,
  );
  const ensure = vi.fn(async () => {});
  const connection = {
    viewer,
    status: "ready",
    session: {
      ...owner.session,
      media,
      profiles: {
        snapshot: () => profiles,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ensure,
      },
    },
  };
  const snapshot = {
    profile: { name: "Local name", picture: "" },
    viewer,
    selected: "https://community.test",
  };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const communities = {
    subscribe,
    snapshot: () => snapshot,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const view = render(
    <ProfileButton
      communities={communities}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    expect(
      screen.getByRole("button", { name: "Your profile" }),
    ).toBeInTheDocument();
    act(() => {
      profiles = new Map([
        [
          viewer,
          {
            name: "Community name",
            picture: "https://community.test/media/avatar.png",
          },
        ],
      ]);
      for (const listener of listeners) listener();
    });
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    expect(
      await screen.findByRole("menu", { name: "Community name" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Availability: Online" }),
    ).toBeVisible();
    expect(ensure).toHaveBeenCalledWith([viewer], "background");
    expect(media).toHaveBeenCalledWith(
      "https://community.test/media/avatar.png",
      "small",
    );
    const button = screen.getByRole("button", { name: "Your profile" });
    expect(button).toHaveAttribute("title", "Community name");
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      "/community-media?url=https%3A%2F%2Fcommunity.test%2Fmedia%2Favatar.png",
    );
    act(() => {
      profiles = new Map([[viewer, { name: "Updated name" }]]);
      for (const listener of listeners) listener();
    });
    expect(button).toHaveAttribute("title", "Updated name");
    expect(button.querySelector("img")).toBeNull();
    expect(snapshot.profile).toEqual({ name: "Local name", picture: "" });
    expect(screen.queryByText("Your profile")).not.toBeInTheDocument();
    expect(screen.queryByText("Your account")).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Set a status" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Status updates are unavailable in this community."),
    ).toBeVisible();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it.each(["escape", "outside", "reopen"])(
  "cancels a held status opening on %s dismissal",
  async (dismiss) => {
    const { createRelaySession } = await import("../../features/relay/session");
    const owner = createRelaySession(null);
    const user = userEvent.setup();
    let release!: () => void;
    const current = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const viewer = "a".repeat(64);
    const connection = {
      scope: "https://status.test",
      session: {
        ...owner.session,
        statuses: { ...owner.session.statuses, writable: true, current },
      },
    };
    const snapshot = {
      profile: { name: "Local", picture: "http://unsafe.test/avatar" },
      viewer,
    };
    const presence = { status: "online", preference: "auto", error: null };
    const subscribe = () => () => {};
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    const view = render(
      <>
        <ProfileButton
          communities={communities}
          settingsSelected={false}
          onSettings={() => {}}
        />
        <button type="button">Outside</button>
      </>,
    );
    try {
      expect(view.container.querySelector('img[src^="http:"]')).toBeNull();
      act(() => screen.getByRole("button", { name: "Your profile" }).focus());
      await user.keyboard("{Enter}");
      await screen.findByRole("menu", { name: "Local" });
      await user.click(screen.getByRole("menuitem", { name: "Set a status" }));
      expect(current).toHaveBeenCalledOnce();
      if (dismiss === "outside")
        await user.click(screen.getByRole("button", { name: "Outside" }));
      else await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("menu", { name: "Local" }),
        ).not.toBeInTheDocument(),
      );
      if (dismiss === "reopen") {
        act(() => screen.getByRole("button", { name: "Your profile" }).focus());
        await user.keyboard("{Enter}");
        await screen.findByRole("menu", { name: "Local" });
      }
      await act(async () => release());
      expect(
        screen.queryByRole("dialog", { name: "Set a status" }),
      ).not.toBeInTheDocument();
      if (dismiss === "reopen")
        expect(screen.getByRole("menu", { name: "Local" })).toBeVisible();
    } finally {
      await act(async () => release?.());
      view.unmount();
      owner.dispose();
    }
  },
);

it("drops the previous community profile on switching and uses local defaults only in Personal space", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const owner = createRelaySession(null);
  const viewer = "a".repeat(64);
  const listeners = new Set<() => void>();
  const oldListeners = new Set<() => void>();
  let oldProfile = { name: "Alpha", picture: "https://alpha.test/avatar.png" };
  const alphaProfiles = {
    snapshot: () => new Map([[viewer, oldProfile]]),
    subscribe: (listener: () => void) => {
      oldListeners.add(listener);
      return () => {
        oldListeners.delete(listener);
      };
    },
    ensure: vi.fn(async () => {}),
  };
  let state = {
    viewer,
    selected: "https://alpha.test" as string | null,
    profile: {
      name: "Personal name",
      picture: "https://public.test/local.png",
    },
  };
  let connection = {
    viewer,
    status: "ready",
    session: {
      ...owner.session,
      profiles: alphaProfiles,
      media: (url: string) => url,
    },
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const presence = { status: "online", preference: "auto", error: null };
  const communities = {
    subscribe,
    snapshot: () => state,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const view = render(
    <ProfileButton
      communities={communities}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    const button = screen.getByRole("button", { name: "Your profile" });
    expect(button).toHaveAttribute("title", "Alpha");
    act(() => {
      state = { ...state, selected: "https://beta.test" };
      connection = {
        ...connection,
        session: {
          ...connection.session,
          profiles: {
            ...alphaProfiles,
            snapshot: () => new Map(),
            subscribe: () => () => {},
          },
        },
      };
      for (const listener of listeners) listener();
    });
    expect(button).not.toHaveAttribute("title", "Alpha");
    expect(button).not.toHaveAttribute("title", "Personal name");
    expect(button.querySelector("img")).toBeNull();
    act(() => {
      oldProfile = { ...oldProfile, name: "Late Alpha" };
      for (const listener of oldListeners) listener();
    });
    expect(button).not.toHaveAttribute("title", "Late Alpha");
    act(() => {
      state = { ...state, selected: null };
      for (const listener of listeners) listener();
    });
    expect(button).toHaveAttribute("title", "Personal name");
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      "https://public.test/local.png",
    );
  } finally {
    view.unmount();
    owner.dispose();
  }
});
