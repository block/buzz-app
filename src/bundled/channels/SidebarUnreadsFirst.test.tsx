// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem, InboxSnapshot } from "../../features/relay/inbox";
import { useWaitingChannels } from "./SidebarUnreadsFirst";

function unreadStore() {
  let inbox: InboxSnapshot = {
    status: "ready",
    items: [],
    freshness: "observed",
  };
  const listeners = new Set<() => void>();
  return {
    unread: {
      inbox: () => inbox,
      subscribeInbox(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as RelaySession["unread"],
    set(waiting: readonly string[]) {
      inbox = {
        ...inbox,
        items: waiting.map(
          (channelId) => ({ channelId, unreadCount: 1 }) as InboxItem,
        ),
      };
      for (const listener of listeners) listener();
    },
  };
}

it("holds the open conversation after it's read, until it's muted", () => {
  const store = unreadStore();
  store.set(["a", "b"]);
  const { result, rerender } = renderHook(
    ({ muted }) => useWaitingChannels(store.unread, muted, "a"),
    { initialProps: { muted: [] as string[] } },
  );
  expect([...result.current]).toEqual(["a", "b"]);
  // Reading the open conversation doesn't pull it out from under you.
  act(() => store.set(["b"]));
  rerender({ muted: [] });
  expect(result.current.has("a")).toBe(true);
  // Muting it while it's open gives up its place.
  rerender({ muted: ["a"] });
  expect([...result.current]).toEqual(["b"]);
});
