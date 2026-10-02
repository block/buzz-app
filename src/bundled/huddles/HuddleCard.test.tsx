// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { foldMessages } from "../../features/relay/fold";
import { createHuddles } from "../../features/huddle/service";
import { HuddleCard, huddleTarget } from "./HuddleCard";

afterEach(cleanup);
it("keeps View available for an expired start after the lifecycle read fails", async () => {
  const parent = "00000000-0000-4000-8000-000000000001";
  const room = "00000000-0000-4000-8000-000000000002";
  const viewer = "ab".repeat(32);
  const store = createRelaySession(null);
  let status: "loading" | "error" = "loading";
  let notify = () => {};
  const dispose = vi.fn();
  const session = {
    ...store.session,
    observe: () => ({
      snapshot: () => ({ status, events: [] }),
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {
          notify = () => {};
        };
      },
      refresh: async () => {
        status = "error";
        notify();
      },
      dispose,
    }),
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: "expired-card",
    viewer,
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
      throw new Error("No call expected");
    },
  );
  const [message] = foldMessages(parent, viewer, [
    {
      id: "1".repeat(64),
      pubkey: viewer,
      kind: 48100,
      created_at: Math.floor(Date.now() / 1000) - 3601,
      tags: [["h", parent]],
      content: JSON.stringify({ ephemeral_channel_id: room }),
    },
  ]);
  assert.exists(message);
  const open = vi.fn(() => true);
  const view = render(
    <HuddleCard
      message={message}
      relay={relay}
      huddles={huddles}
      open={open}
      showWindow={async () => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "View" }));
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  expect(open).toHaveBeenCalledWith(huddleTarget(parent, room));
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
  huddles.dispose();
  store.dispose();
});
