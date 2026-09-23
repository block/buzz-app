// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { IncomingListener } from "../../features/relay/incoming";
import { useHiddenDms } from "./useHiddenDms";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function fixture() {
  let latest: { id: string; createdAt: number } | undefined = {
    id: "before",
    createdAt: 99,
  };
  const listeners = new Set<() => void>();
  const incoming = new Set<IncomingListener>();
  type ObserveSend = Parameters<
    NonNullable<RelaySession["outbox"]>["observeSend"]
  >[0];
  const outgoing = new Set<ObserveSend>();
  let onRead = () => {};
  const read = vi.fn(async () => {
    onRead();
    return [];
  });
  const session = {
    channels: {
      list: () => ({
        channels: [{ id: "dm", name: "DM", channelType: "dm" }],
      }),
    },
    read,
    outbox: {
      observeSend(listener: ObserveSend) {
        outgoing.add(listener);
        return () => outgoing.delete(listener);
      },
    },
    unread: {
      snapshot: () => ({ latestMessage: latest }),
      subscribe: (_target: unknown, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    subscribeIncoming(listener: IncomingListener) {
      incoming.add(listener);
      return () => incoming.delete(listener);
    },
  } as unknown as RelaySession;
  return {
    session,
    read,
    onNextRead(callback: () => void) {
      onRead = callback;
    },
    evidence(id: string, createdAt: number) {
      latest = { id, createdAt };
      for (const listener of listeners) listener();
    },
    receive(channelId: string) {
      for (const listener of incoming)
        listener([
          {
            channelId,
            messageId: "incoming",
            createdAt: 100,
            authorId: "sender",
            previewContent: "hello",
          },
        ]);
    },
    deliver(channelId: string) {
      for (const listener of outgoing)
        listener(
          { kind: 9, tags: [["h", channelId]] } as Parameters<ObserveSend>[0],
          new AbortController().signal,
        )?.([]);
    },
    pendingDelivery(channelId: string) {
      const listener = [...outgoing][0];
      return listener?.(
        { kind: 9, tags: [["h", channelId]] } as Parameters<ObserveSend>[0],
        new AbortController().signal,
      );
    },
  };
}

it("hides per scope, survives remount, and restores on later verified activity", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(100_000));
  const h = fixture();
  const first = renderHook(() => useHiddenDms("community:alice", h.session));
  act(() => first.result.current.hide("dm"));
  expect(first.result.current.hiddenIds.has("dm")).toBe(true);
  first.unmount();

  const restored = renderHook(() => useHiddenDms("community:alice", h.session));
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
  const other = renderHook(() => useHiddenDms("community:bob", h.session));
  expect(other.result.current.hiddenIds.has("dm")).toBe(false);

  act(() => h.evidence("older-backfill", 98));
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.evidence("new-message", 100));
  expect(restored.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.evidence("later-message", 101));
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
});

it("restores a hidden DM on a new live message, including when its timestamp is old", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(100_000));
  const h = fixture();
  const view = renderHook(() => useHiddenDms("community:alice", h.session));
  act(() => view.result.current.hide("dm"));
  act(() => h.receive("different"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.receive("dm"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(false);
});

it("checks a hidden DM directly on return for messages missed while closed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(100_000));
  const h = fixture();
  const first = renderHook(() => useHiddenDms("community:alice", h.session));
  act(() => first.result.current.hide("dm"));
  first.unmount();
  h.onNextRead(() => h.evidence("offline-message", 101));
  const restored = renderHook(() => useHiddenDms("community:alice", h.session));
  await act(async () => {
    await Promise.resolve();
  });
  expect(restored.result.current.hiddenIds.has("dm")).toBe(false);
  expect(h.read).toHaveBeenCalledWith(
    [{ kinds: [9, 40002], "#h": ["dm"], limit: 1 }],
    expect.objectContaining({ priority: "background" }),
  );
});

it("restores a hidden DM after an outgoing message is delivered", () => {
  const h = fixture();
  const view = renderHook(() => useHiddenDms("community:alice", h.session));
  act(() => view.result.current.hide("dm"));
  act(() => h.deliver("different"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
  act(() => h.deliver("dm"));
  expect(view.result.current.hiddenIds.has("dm")).toBe(false);
});

it("does not restore a DM hidden again after an older send began", () => {
  const h = fixture();
  const view = renderHook(() => useHiddenDms("community:alice", h.session));
  act(() => view.result.current.hide("dm"));
  const finish = h.pendingDelivery("dm");
  act(() => view.result.current.hide("dm"));
  act(() => finish?.([]));
  expect(view.result.current.hiddenIds.has("dm")).toBe(true);
});
