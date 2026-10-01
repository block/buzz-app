// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
  createHuddleWindow,
  type HuddleWindowAction,
  type WindowBridge,
} from "./window";
import type { Huddles, HuddleSnapshot } from "./service";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
function harness() {
  const store = createRelaySession(null);
  let snapshot: HuddleSnapshot = {
    id: "00000000-0000-4000-8000-000000000001",
    phase: "connected",
    muted: false,
    participants: [],
    destination: {
      scope: "scope",
      viewer: "viewer",
      channelId: "channel",
      channelName: "Design",
      relayUrl: "wss://example.test",
    },
  };
  const listeners = new Set<() => void>();
  const call: Huddles = {
    snapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    canJoin: () => true,
    join: async () => {},
    start: async () => {},
    mute: vi.fn(),
    leave: vi.fn(async () => {}),
    dispose: async () => {},
  };
  const relay = { snapshot: () => ({ session: store.session }) } as RelayData;
  let action = (_id: string, _action: HuddleWindowAction) => {};
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge: WindowBridge = {
    open: vi.fn(async (_view, act) => {
      action = act;
      await gate;
    }),
    update: vi.fn(async () => {}),
  };
  const companion = createHuddleWindow(call, relay, bridge);
  return {
    companion,
    bridge,
    call,
    release,
    action: (id: string, a: HuddleWindowAction) => action(id, a),
    set(next: HuddleSnapshot) {
      snapshot = next;
      for (const fn of listeners) fn();
    },
    async dispose() {
      release();
      await companion.dispose();
      store.dispose();
    },
  };
}
it("closes a late-created window after leaving, and ignores stale controls", async () => {
  const h = harness();
  try {
    const opening = h.companion.open();
    await Promise.resolve();
    await Promise.resolve();
    h.set({ phase: "idle", participants: [], muted: false });
    h.release();
    await opening;
    await vi.waitFor(() =>
      expect(h.bridge.update).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000001",
        null,
      ),
    );
    h.action("00000000-0000-4000-8000-000000000001", "leave");
    expect(h.call.leave).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});
it("synchronizes mute and rejects commands from another call", async () => {
  const h = harness();
  try {
    h.release();
    await h.companion.open();
    const id = h.call.snapshot().id ?? "";
    h.action(id, "mute");
    expect(h.call.mute).toHaveBeenCalledOnce();
    h.action("old-call", "leave");
    expect(h.call.leave).not.toHaveBeenCalled();
    h.set({ ...h.call.snapshot(), muted: true });
    await vi.waitFor(() =>
      expect(h.bridge.update).toHaveBeenLastCalledWith(
        id,
        expect.objectContaining({ muted: true }),
      ),
    );
    h.action(id, "leave");
    expect(h.call.leave).toHaveBeenCalledOnce();
  } finally {
    await h.dispose();
  }
});
it("disposal waits for a pending open then retires its native window", async () => {
  const h = harness();
  const opening = h.companion.open();
  const disposing = h.companion.dispose();
  h.release();
  await opening;
  await disposing;
  expect(h.bridge.update).toHaveBeenLastCalledWith(
    "00000000-0000-4000-8000-000000000001",
    null,
  );
  await h.dispose();
});

it("retires partially created windows when native Show or Focus rejects", async () => {
  const h = harness();
  vi.mocked(h.bridge.open).mockRejectedValueOnce(new Error("Focus failed"));
  try {
    await expect(h.companion.open()).rejects.toThrow("Focus failed");
    expect(h.bridge.update).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      null,
    );
    h.release();
    await h.companion.open();
    expect(h.bridge.open).toHaveBeenCalledTimes(2);
  } finally {
    await h.dispose();
  }
});
it("disposal awaits cleanup when a pending native open rejects", async () => {
  const h = harness();
  let reject = (_: Error) => {};
  vi.mocked(h.bridge.open).mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  let releaseCleanup = () => {};
  vi.mocked(h.bridge.update).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }),
  );
  const opening = h.companion.open();
  const failed = expect(opening).rejects.toThrow("Focus failed");
  await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledOnce());
  let disposed = false;
  const disposing = h.companion.dispose().then(() => {
    disposed = true;
  });
  reject(new Error("Focus failed"));
  await vi.waitFor(() => expect(h.bridge.update).toHaveBeenCalledOnce());
  expect(disposed).toBe(false);
  releaseCleanup();
  await failed;
  await disposing;
  expect(disposed).toBe(true);
  await h.dispose();
});

it("opens once per call, falls back on close, and reopens only explicitly", async () => {
  const h = harness();
  try {
    h.release();
    h.set({ ...h.call.snapshot() });
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledOnce());
    expect(h.companion.snapshot()).toEqual({ visible: true, failed: false });
    const id = h.call.snapshot().id ?? "";
    h.action(id, "closed");
    expect(h.companion.snapshot().visible).toBe(false);
    expect(h.call.leave).not.toHaveBeenCalled();
    h.set({ ...h.call.snapshot(), muted: true });
    await Promise.resolve();
    expect(h.bridge.open).toHaveBeenCalledOnce();
    await h.companion.open();
    expect(h.companion.snapshot().visible).toBe(true);
    h.set({ ...h.call.snapshot(), id: "00000000-0000-4000-8000-000000000002" });
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledTimes(3));
    h.action(id, "closed");
    expect(h.companion.snapshot().visible).toBe(true);
  } finally {
    await h.dispose();
  }
});
it("keeps compact controls available after an automatic open failure", async () => {
  const h = harness();
  vi.mocked(h.bridge.open).mockRejectedValueOnce(new Error("Focus failed"));
  try {
    h.set({ ...h.call.snapshot() });
    await vi.waitFor(() =>
      expect(h.companion.snapshot()).toEqual({ visible: false, failed: true }),
    );
    h.set({ ...h.call.snapshot(), muted: true });
    expect(h.bridge.open).toHaveBeenCalledOnce();
    h.release();
    await h.companion.open();
    expect(h.companion.snapshot()).toEqual({ visible: true, failed: false });
  } finally {
    await h.dispose();
  }
});

it("keeps the compact player visible when the window closes before Open resolves", async () => {
  const h = harness();
  try {
    const opening = h.companion.open();
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledOnce());
    h.action(h.call.snapshot().id ?? "", "closed");
    h.release();
    await opening;
    expect(h.companion.snapshot()).toEqual({ visible: false, failed: false });
    expect(h.call.leave).not.toHaveBeenCalled();
    h.set({ ...h.call.snapshot(), muted: true });
    expect(h.bridge.open).toHaveBeenCalledOnce();
  } finally {
    await h.dispose();
  }
});
it("ignores delayed closure callbacks from an earlier window opening", async () => {
  const h = harness();
  try {
    h.release();
    await h.companion.open();
    const stale = vi.mocked(h.bridge.open).mock.calls[0]?.[1];
    const id = h.call.snapshot().id ?? "";
    h.action(id, "closed");
    await h.companion.open();
    stale?.(id, "closed");
    expect(h.companion.snapshot().visible).toBe(true);
    h.action(id, "closed");
    expect(h.companion.snapshot().visible).toBe(false);
  } finally {
    await h.dispose();
  }
});

it("sends speaking levels with the matching participant", async () => {
  const h = harness();
  try {
    h.release();
    h.set({
      ...h.call.snapshot(),
      participants: ["viewer", "alex"],
      speakers: { alex: 0.6 },
    });
    await h.companion.open();
    expect(h.bridge.open).toHaveBeenCalledWith(
      expect.objectContaining({
        participants: [
          expect.objectContaining({ key: "viewer", level: 0 }),
          expect.objectContaining({ key: "alex", level: 0.6 }),
        ],
      }),
      expect.any(Function),
    );
  } finally {
    await h.dispose();
  }
});
