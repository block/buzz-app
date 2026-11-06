// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { foldMessages } from "../../features/relay/fold";
import { createHuddles } from "../../features/huddle/service";
import { HuddleCard, huddleTarget } from "./HuddleCard";

afterEach(cleanup);
it.each([-3601, 86400, -30, 0])(
  "preserves View and prevents joining expired, future, ended, or archived starts (%s)",
  async (offset) => {
    const parent = "00000000-0000-4000-8000-000000000001";
    const room = "00000000-0000-4000-8000-000000000002";
    const viewer = "ab".repeat(32);
    const store = createRelaySession(null);
    let status: "loading" | "error" = "loading";
    let notify = () => {};
    const dispose = vi.fn();
    const session = {
      ...store.session,
      channels: {
        ...store.session.channels,
        list: () => ({
          status: "ready" as const,
          channels: [
            {
              id: parent,
              name: "Parent",
              ...(offset === 0 ? { archived: true as const } : {}),
            },
          ],
        }),
      },
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
        created_at: Math.floor(Date.now() / 1000) + offset,
        tags: [["h", parent]],
        content: JSON.stringify({ ephemeral_channel_id: room }),
      },
      ...(offset === -30
        ? [
            {
              id: "2".repeat(64),
              pubkey: viewer,
              kind: 48103,
              created_at: Math.floor(Date.now() / 1000) - 10,
              tags: [["h", parent]],
              content: JSON.stringify({ ephemeral_channel_id: room }),
            },
          ]
        : []),
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
    if (offset === 0) {
      const join = screen.getByRole("button", {
        name: "Join",
      }) as HTMLButtonElement;
      expect(join.disabled).toBe(true);
    } else {
      fireEvent.click(await screen.findByRole("button", { name: "View" }));
      expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
      expect(open).toHaveBeenCalledWith(huddleTarget(parent, room));
    }
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    huddles.dispose();
    store.dispose();
  },
);

it("becomes joinable when a slightly future-dated start is reached", () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12, 0, 0, 500) });
  const parent = "00000000-0000-4000-8000-000000000001";
  const room = "00000000-0000-4000-8000-000000000002";
  const viewer = "ab".repeat(32);
  const store = createRelaySession(null);
  const session = {
    ...store.session,
    channels: {
      ...store.session.channels,
      list: () => ({
        status: "ready" as const,
        channels: [{ id: parent, name: "Parent" }],
      }),
    },
    observe: () => ({
      snapshot: () => ({ status: "ready" as const, events: [] }),
      subscribe: () => () => {},
      refresh: async () => {},
      dispose() {},
    }),
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: "future-card",
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
      // The sender's clock is 1.5 seconds ahead of this client.
      created_at: Math.floor((Date.now() + 1500) / 1000),
      tags: [["h", parent]],
      content: JSON.stringify({ ephemeral_channel_id: room }),
    },
  ]);
  assert.exists(message);
  const view = render(
    <HuddleCard
      message={message}
      relay={relay}
      huddles={huddles}
      open={() => true}
      showWindow={async () => {}}
    />,
  );
  expect(screen.queryByRole("region", { name: "Huddle ended" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.getByRole("region", { name: "Huddle" })).toBeTruthy();
  expect(screen.getByText("Huddle in progress")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  huddles.dispose();
  store.dispose();
  vi.useRealTimers();
});
