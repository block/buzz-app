// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { useUnreadChannelIds } from "./useSidebarFilters";

afterEach(cleanup);

it("reacts to message, manual and thread unread evidence and cleans up its subscriptions", () => {
  const owner = createRelaySession(null);
  const listeners = new Set<() => void>();
  const activityListeners = new Set<() => void>();
  const states = new Map<
    string,
    { count: number; manual?: boolean; thread?: boolean }
  >();
  const subscribe = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const unread = {
    ...owner.session.unread,
    snapshot: (
      target: Parameters<typeof owner.session.unread.snapshot>[0],
    ) => ({
      ...owner.session.unread.snapshot(target),
      observedCount: states.get(target.channelId)?.count ?? null,
      manual: states.get(target.channelId)?.manual
        ? ("local-only" as const)
        : ("none" as const),
    }),
    activity: (id: string) => ({
      ...owner.session.unread.activity(id),
      items: states.get(id)?.thread
        ? [
            {
              channelId: id,
              rootId: "root",
              latestMessageId: "reply",
              authorId: "other",
              createdAt: 1,
              preview: "Reply",
              unreadCount: 1,
            },
          ]
        : [],
    }),
    subscribe: (_target: unknown, listener: () => void) =>
      subscribe(listeners, listener),
    subscribeActivity: (_id: string, listener: () => void) =>
      subscribe(activityListeners, listener),
  };
  const { result, rerender, unmount } = renderHook(
    ({ ids }) => useUnreadChannelIds(unread, ids),
    { initialProps: { ids: JSON.stringify(["alpha", "beta", "gamma"]) } },
  );
  const ids = () => [...result.current];
  expect(ids()).toEqual([]);
  act(() => {
    states.set("beta", { count: 1 });
    for (const listener of listeners) listener();
  });
  expect(ids()).toEqual(["beta"]);
  act(() => {
    states.set("beta", { count: 0, manual: true });
    states.set("gamma", { count: 0, thread: true });
    for (const listener of activityListeners) listener();
  });
  expect(ids()).toEqual(["beta", "gamma"]);
  act(() => {
    states.clear();
    for (const listener of listeners) listener();
  });
  expect(ids()).toEqual([]);
  rerender({ ids: "[]" });
  expect(listeners.size).toBe(0);
  expect(activityListeners.size).toBe(0);
  unmount();
  owner.dispose();
});
