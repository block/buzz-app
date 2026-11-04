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
  const reading = vi.fn(() => ({
    view: vi.fn(),
    observe: vi.fn(async () => {}),
    catchUp: vi.fn(async () => {}),
    dispose: vi.fn(),
  }));
  const session = {
    ...store.session,
    viewer: VIEWER,
    media: (url: string) => url,
    unread: {
      ...store.session.unread,
      reading,
      sync: () => ({ capability: "frontier-sync" as const }),
    },
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
  const bridge: PopoutBridge = {
    open: vi.fn(async (binding, _view, callback) => {
      act = callback;
      incarnation = binding.incarnation;
      return { label: "popout-1", existing: false };
    }),
    update: vi.fn(async () => {}),
    detached: vi.fn(async () => []),
  };
  const openLink = vi.fn(() => true);
  const windows = createPopoutWindows(relay, { bridge, openLink });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    windows,
    bridge,
    openLink,
    reading,
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

it("owns reading leases: a disposed lease answers no later observation", async () => {
  const h = harness();
  await h.windows.open({ channelId: "channel", threadRootId: ROOT });
  h.control("reading", JSON.stringify({ op: "acquire", lease: "L1" }));
  expect(h.reading).toHaveBeenCalledWith("channel");
  const lease = h.reading.mock.results[0]?.value as {
    observe: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  // Ids outside this window's projection are never claimed as read.
  h.control(
    "reading",
    JSON.stringify({ op: "observe", lease: "L1", ids: ["c".repeat(64)] }),
  );
  expect(lease.observe).not.toHaveBeenCalled();
  h.control("reading", JSON.stringify({ op: "dispose", lease: "L1" }));
  expect(lease.dispose).toHaveBeenCalledTimes(1);
  // Delayed IPC after dispose: nothing is revived.
  h.control(
    "reading",
    JSON.stringify({ op: "observe", lease: "L1", ids: [ROOT] }),
  );
  expect(lease.observe).not.toHaveBeenCalled();
  h.control("reading", "not json");
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
