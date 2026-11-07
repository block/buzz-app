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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const parent = "00000000-0000-4000-8000-000000000001";
const room = "00000000-0000-4000-8000-000000000002";
function mount(offset: number) {
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
  return {
    open,
    unmount() {
      view.unmount();
      expect(dispose).toHaveBeenCalledOnce();
      huddles.dispose();
      store.dispose();
    },
  };
}
it.each([-3601, 86400, -30, 0])(
  "preserves View and prevents joining expired, future, ended, or archived starts (%s)",
  async (offset) => {
    const card = mount(offset);
    if (offset === 0) {
      const join = screen.getByRole("button", {
        name: "Join",
      }) as HTMLButtonElement;
      expect(join.disabled).toBe(true);
    } else {
      fireEvent.click(await screen.findByRole("button", { name: "View" }));
      expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
      expect(card.open).toHaveBeenCalledWith(huddleTarget(parent, room));
    }
    card.unmount();
  },
);

it("becomes joinable when a slightly future-dated start is reached", () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12, 0, 0, 500) });
  // The sender's clock is 1.5 seconds ahead of this client.
  const card = mount(2);
  expect(screen.queryByRole("region", { name: "Huddle ended" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  // This clock can also step back slightly while the card waits.
  vi.setSystemTime(Date.now() - 1);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByRole("region", { name: "Huddle" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByText("Huddle in progress")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
  card.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
