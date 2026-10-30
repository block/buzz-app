// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { createHuddles } from "../../features/huddle/service";
import { MenuRoot, MenuPopup } from "../../shared/design-system/ui/Menu";
import { HuddleLauncher, SoloHuddleMenu } from "./HuddleLauncher";

afterEach(cleanup);

it("moves idle Solo huddles to the menu while preserving Team's header action", async () => {
  const store = createRelaySession(null);
  const channel = {
    id: "chat",
    name: "Chat",
    channelType: "solo" as "solo" | "stream",
  };
  const list = { status: "ready" as const, channels: [channel] };
  const session = {
    ...store.session,
    channels: { ...store.session.channels, list: () => list },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: "https://example.com:viewer",
    viewer: "viewer",
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const huddles = createHuddles(
    relay,
    {
      available: false,
      open: async () => {},
      close: async () => {},
      touch: async () => {},
      send: async () => {},
    },
    async () => {
      throw new Error("No audio expected");
    },
  );
  const start = vi.spyOn(huddles, "start").mockResolvedValue();
  const context = {
    scope: snapshot.scope,
    viewer: "viewer",
    channelId: "chat",
    channelName: "Chat",
    relayUrl: "wss://example.com",
  };
  const props = {
    context,
    relay,
    huddles,
    showWindow: async () => {},
    available: () => true,
  };
  try {
    const view = render(<HuddleLauncher {...props} />);
    expect(screen.queryByRole("button", { name: "Start a huddle" })).toBeNull();
    view.rerender(
      <MenuRoot open>
        <MenuPopup>
          <SoloHuddleMenu {...props} session={session} channelId="chat" />
        </MenuPopup>
      </MenuRoot>,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Start a huddle" }),
    );
    expect(start).toHaveBeenCalledWith(context);
    const connecting = {
      phase: "connecting" as const,
      muted: false,
      participants: [],
    };
    vi.spyOn(huddles, "snapshot").mockReturnValue(connecting);
    const leave = vi.spyOn(huddles, "leave").mockResolvedValue();
    view.rerender(<HuddleLauncher {...props} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel Huddle connection" }),
    );
    expect(leave).toHaveBeenCalledOnce();
    vi.mocked(huddles.snapshot).mockRestore();
    channel.channelType = "stream";
    view.rerender(<HuddleLauncher {...props} />);
    expect(
      screen.getByRole("button", { name: "Start or join a huddle" }),
    ).toBeVisible();
    view.unmount();
  } finally {
    await huddles.dispose();
    store.dispose();
  }
});
