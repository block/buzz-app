// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelPanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { useChannelPanels } from "./useChannelPanels";

afterEach(cleanup);

it("makes settings and launchers mutually exclusive without resurrecting a closed drawer", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const context: ChannelPanelContext = {
    scope: "scope",
    viewer: "viewer",
    channelId: "alpha",
    channelName: "Alpha",
    relayUrl: "wss://example.com",
  };
  const panel: RegisteredPanel = {
    id: "terminal",
    key: "fixture:terminal",
    pluginId: "fixture",
    revision: "1",
    title: "Terminal",
    matches: () => true,
    channelLauncher: ({ toggle, pressed }) => (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={() => toggle("terminal")}
      >
        Terminal
      </button>
    ),
    component: () => <p>Terminal contents</p>,
  };
  const available = [panel];
  const panels: Panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    register: () => {},
    resolve: () => panel,
  };
  function Harness() {
    const [settings, setSettings] = useState(false);
    const drawer = useChannelPanels(panels, context, () => {
      onOpen();
      setSettings(false);
    });
    return (
      <>
        {drawer.launchers}
        <button
          type="button"
          onClick={() => {
            drawer.close();
            setSettings(true);
          }}
        >
          Settings
        </button>
        {settings && (
          <button type="button" onClick={() => setSettings(false)}>
            Close settings
          </button>
        )}
        {drawer.content}
      </>
    );
  }
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Terminal" }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("region", { name: "Terminal drawer" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  expect(
    screen.queryByRole("region", { name: "Terminal drawer" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await user.click(screen.getByRole("button", { name: "Close settings" }));
  expect(
    screen.queryByRole("region", { name: "Terminal drawer" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Terminal" }));
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(
    screen.queryByRole("button", { name: "Close settings" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Terminal drawer" })).toBeVisible();
});
