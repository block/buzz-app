// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createThreadViews,
  ThreadViews,
  useLoadedThread,
} from "./thread-views";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type { ChannelMessage } from "../relay/contracts";
afterEach(cleanup);
it("shares only the same session/channel/root's owned snapshot and revokes on unregister", () => {
  const session = {} as RelaySession,
    other = {} as RelaySession;
  const views = createThreadViews();
  let snapshot: ThreadSnapshot = {
    status: "ready",
    root: { id: "root" } as ChannelMessage,
    replies: [],
    canLoadMore: false,
    limited: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const refresh = vi.fn(),
    dispose = vi.fn();
  const view: ThreadView = {
    snapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    refresh,
    loadMore: vi.fn(),
    dispose,
  };
  function Reader({
    owner = session,
    channel = "alpha",
    root = "root",
  }: {
    owner?: RelaySession;
    channel?: string;
    root?: string;
  }) {
    const loaded = useLoadedThread(owner, channel, root);
    return (
      <p>
        {loaded ? `${loaded.status}:${loaded.replies.length}` : "unavailable"}
      </p>
    );
  }
  const rendered = render(
    <ThreadViews value={views}>
      <Reader />
    </ThreadViews>,
    { reactStrictMode: true },
  );
  expect(screen.getByText("unavailable")).toBeTruthy();
  let release = () => {};
  act(() => {
    release = views.register(session, "alpha", view);
  });
  expect(screen.getByText("ready:0")).toBeTruthy();
  act(() => {
    snapshot = { ...snapshot, replies: [{ id: "handoff" } as ChannelMessage] };
    for (const fn of listeners) fn();
  });
  expect(screen.getByText("ready:1")).toBeTruthy();
  for (const props of [
    { owner: other },
    { channel: "beta" },
    { root: "other-root" },
  ]) {
    rendered.rerender(
      <ThreadViews value={views}>
        <Reader {...props} />
      </ThreadViews>,
    );
    expect(screen.getByText("unavailable")).toBeTruthy();
  }
  rendered.rerender(
    <ThreadViews value={views}>
      <Reader />
    </ThreadViews>,
  );
  act(() => {
    snapshot = { ...snapshot, root: undefined, replies: [] };
    for (const fn of listeners) fn();
  });
  expect(screen.getByText("unavailable")).toBeTruthy();
  act(() => {
    release();
    release();
  });
  expect(listeners.size).toBe(0);
  expect(refresh).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
});
