// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
  createPopoutWindows,
  type PopoutBridge,
  type PopoutControl,
} from "./window";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";

const ROOT = "b".repeat(64);
const VIEWER = "a".repeat(64);

function harness() {
  const store = createRelaySession(null);
  const session = {
    ...store.session,
    viewer: VIEWER,
    media: (url: string) => url,
  };
  let connection = {
    session,
    status: "ready",
    scope: "scope",
    viewer: VIEWER,
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => connection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as RelayData;
  let act: ((control: PopoutControl) => void) | undefined;
  let incarnation = 0;
  let gate: Promise<void> | undefined;
  let fail: Error | undefined;
  const bridge: PopoutBridge = {
    open: vi.fn(async (binding, _view, callback) => {
      act = callback;
      incarnation = binding.incarnation;
      if (gate) await gate;
      if (fail) throw fail;
      return { label: "popout-1", existing: false };
    }),
    update: vi.fn(async () => {}),
    detached: vi.fn(async () => []),
  };
  const openLink = vi.fn(() => true);
  const openActivity = vi.fn();
  const windows = createPopoutWindows(relay, {
    bridge,
    openLink,
    openActivity,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    windows,
    bridge,
    openLink,
    openActivity,
    flush,
    control: (action: PopoutControl["action"], text?: string, stale = false) =>
      act?.({
        label: "popout-1",
        incarnation: stale ? incarnation - 1 : incarnation,
        action,
        ...(text !== undefined ? { text } : {}),
      }),
    changeScope() {
      connection = { ...connection, scope: "other" };
      for (const listener of listeners) listener();
    },
    holdOpen() {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failOpen(error: Error) {
      fail = error;
    },
  };
}

it("opens one window per target, bound to scope, viewer and incarnation", async () => {
  const h = harness();
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  expect(h.bridge.open).toHaveBeenCalledTimes(1);
  const [binding, view] = (h.bridge.open as ReturnType<typeof vi.fn>).mock
    .calls[0] as [Record<string, unknown>, Record<string, unknown>];
  expect(binding).toMatchObject({
    channelId: "channel",
    threadRootId: ROOT,
    scope: "scope",
    viewer: VIEWER,
  });
  expect(typeof binding.incarnation).toBe("number");
  expect(view).toMatchObject({ status: "loading", writable: false });
  expect(h.windows.isOpen({ channelId: "channel", threadRootId: ROOT })).toBe(
    true,
  );
  // Reopening the same target focuses the existing window natively; no new owner.
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  expect(h.bridge.open).toHaveBeenCalledTimes(2);
  await h.flush();
  expect(h.bridge.update).not.toHaveBeenCalledWith("popout-1", null);
});

it("rejects a thread root that is not an event id", async () => {
  const h = harness();
  await expect(
    h.windows.open({ channelId: "channel", threadRootId: "nope" }),
  ).rejects.toThrow("Invalid thread");
});

it("drops actions from an earlier incarnation and retires on close", async () => {
  const h = harness();
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  h.control("openInMain", undefined, true);
  expect(h.openLink).not.toHaveBeenCalled();
  h.control("openInMain");
  expect(h.openLink).toHaveBeenCalledWith(
    `buzz://message?channel=channel&id=${ROOT}&thread=${ROOT}`,
  );
  h.control("closed");
  await h.flush();
  expect(h.windows.isOpen({ channelId: "channel", threadRootId: ROOT })).toBe(
    false,
  );
  expect(h.bridge.update).toHaveBeenCalledWith("popout-1", null);
});

it("offers no composer until the exact root is verified", async () => {
  const h = harness();
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  const [, view] = (h.bridge.open as ReturnType<typeof vi.fn>).mock
    .calls[0] as [unknown, Record<string, unknown>];
  // Offline, the root never loads: the window opens read-only with no
  // composer token, and nothing is claimed read for it.
  expect(view.root).toBeUndefined();
  expect(view.writable).toBe(false);
  expect(view.composer).toBeUndefined();
  expect(typeof view.reading).toBe("string");
});

it("retires a window whose scope changed while native creation was pending", async () => {
  const h = harness();
  const release = h.holdOpen();
  const opening = h.windows.open({ channelId: "channel", threadRootId: ROOT });
  await h.flush();
  h.changeScope();
  release();
  await opening;
  await h.flush();
  expect(h.windows.isOpen({ channelId: "channel", threadRootId: ROOT })).toBe(
    false,
  );
  expect(h.bridge.update).toHaveBeenCalledWith("popout-1", null);
});

it("destroys a window created after the owner was disposed", async () => {
  const h = harness();
  const release = h.holdOpen();
  const opening = h.windows.open({ channelId: "channel", threadRootId: ROOT });
  await h.flush();
  const disposing = h.windows.dispose();
  release();
  await opening;
  await disposing;
  expect(h.bridge.update).toHaveBeenCalledWith("popout-1", null);
  expect(h.windows.isOpen({ channelId: "channel", threadRootId: ROOT })).toBe(
    false,
  );
});

it("releases its reader when native creation fails", async () => {
  const h = harness();
  h.failOpen(new Error("No window"));
  await expect(
    h.windows.open({ channelId: "channel", threadRootId: ROOT }),
  ).rejects.toThrow("No window");
  expect(h.windows.isOpen({ channelId: "channel", threadRootId: ROOT })).toBe(
    false,
  );
  await h.flush();
  expect(h.bridge.update).not.toHaveBeenCalled();
});

it("retires every window with a notice when the scope changes", async () => {
  const h = harness();
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  const seen = vi.fn();
  h.windows.notices.subscribe(seen);
  h.changeScope();
  await h.flush();
  expect(h.bridge.update).toHaveBeenCalledWith("popout-1", null);
  expect(seen).toHaveBeenCalled();
  const [notice] = h.windows.notices.snapshot();
  expect(notice?.text).toMatch(/community or session changed/);
  // Claimed once; a second host mount shows nothing.
  expect(h.windows.notices.claim(notice?.id ?? -1)).toBe(true);
  expect(h.windows.notices.claim(notice?.id ?? -1)).toBe(false);
});

it("retires windows left by an earlier renderer at startup", async () => {
  const store = createRelaySession(null);
  const bridge: PopoutBridge = {
    open: vi.fn(),
    update: vi.fn(async () => {}),
    detached: vi.fn(async () => ["popout-old"]),
  };
  const relay = {
    snapshot: () => ({ session: store.session, status: "ready" }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const windows = createPopoutWindows(relay, { bridge });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(bridge.update).toHaveBeenCalledWith("popout-old", null);
  await windows.dispose();
});

it("names windows holding unsent work for a community exit, until they let go or close", async () => {
  const h = harness();
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  const changed = vi.fn();
  h.windows.subscribeHeld(changed);
  expect(h.windows.held()).toEqual([]);
  h.control("guard", "1");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(h.windows.held()).toEqual([
    "The pop-out window for “Conversation” has an unsent reply.",
  ]);
  h.control("guard", "1");
  expect(changed).toHaveBeenCalledTimes(1);
  h.control("guard", "0");
  expect(h.windows.held()).toEqual([]);
  h.control("guard", "1");
  h.control("closed");
  expect(h.windows.held()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(4);
});

it("routes an agent's activity view through the activity opener with this window's target", async () => {
  const h = harness();
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  const activity = `buzz:profile?agent=${"d".repeat(64)}&tab=activity`;
  h.control("openLink", activity);
  expect(h.openActivity).toHaveBeenCalledWith(activity, {
    channelId: "channel",
    threadRootId: ROOT,
  });
  expect(h.openLink).not.toHaveBeenCalled();
  h.control("openLink", "buzz://channel/other");
  expect(h.openLink).toHaveBeenCalledWith("buzz://channel/other");
});
