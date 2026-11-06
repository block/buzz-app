// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SidebarRow } from "../../features/channel-navigation/sidebar-rows-service";
import type { RelayData } from "../../features/relay/service";
import type { UnreadSnapshot } from "../../features/relay/unread";
import { hideMutedRows, mutedRows } from "./muted";

afterEach(cleanup);

const quiet: UnreadSnapshot = {
  target: { kind: "channel", channelId: "beta" },
  observedCount: 3,
  attentionCount: 0,
  coverage: "observed",
  freshness: "observed",
  manual: "none",
};

function fakeSession(name: string) {
  const listeners = {
    preferences: new Set<() => void>(),
    channels: new Set<() => void>(),
    unread: new Map<string, Set<() => void>>(),
  };
  const state = {
    cached: false,
    muted: ["beta", "gamma", "person"],
    starred: ["gamma"],
    attention: new Set<string>(),
  };
  const add = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const session = {
    name,
    sidebarPreferences: {
      snapshot: () => ({
        status: "ready",
        ...(state.cached ? { cached: true } : {}),
        data: {
          sections: [],
          assignments: {},
          starred: state.starred,
          muted: state.muted,
        },
      }),
      subscribe: (listener: () => void) => add(listeners.preferences, listener),
    },
    channels: {
      list: () => ({
        status: "ready",
        channels: [
          { id: "alpha", name: "Alpha" },
          { id: "beta", name: "Beta" },
          { id: "gamma", name: "Gamma" },
          { id: "person", name: "Person", channelType: "dm" },
        ],
      }),
      subscribeList: (listener: () => void) =>
        add(listeners.channels, listener),
    },
    unread: {
      snapshot: ({ channelId }: { channelId: string }) => ({
        ...quiet,
        attentionCount: state.attention.has(channelId) ? 1 : 0,
      }),
      subscribe: (
        { channelId }: { channelId: string },
        listener: () => void,
      ) => {
        const set = listeners.unread.get(channelId) ?? new Set();
        listeners.unread.set(channelId, set);
        return add(set, listener);
      },
    },
  };
  const notify = (set: Iterable<() => void>) => {
    for (const listener of [...set]) listener();
  };
  return {
    session,
    state,
    listeners,
    preferencesChanged: () => notify(listeners.preferences),
    unreadChanged: (id: string) => notify(listeners.unread.get(id) ?? []),
  };
}

function fakeRelay(session: unknown) {
  const listeners = new Set<() => void>();
  let current = session;
  const relay = {
    snapshot: () => ({ session: current }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  return {
    relay,
    listeners,
    replace(next: unknown) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const row = (id: string, change: Partial<SidebarRow> = {}): SidebarRow => ({
  id,
  kind: "team",
  label: id,
  sectionKey: "channels",
  channel: { id, name: id },
  unread: { ...quiet, target: { kind: "channel", channelId: id } },
  selected: false,
  ...change,
});

it("hides confirmed muted Team rows, keeps exceptions, and marks resurfaced attention", () => {
  const f = fakeSession("one");
  const render_ = hideMutedRows(fakeRelay(f.session).relay).render;
  if (!render_) throw new Error("missing render");
  const host = <button type="button">host</button>;
  expect(render_(row("beta"), host)).toBeNull();
  expect(render_(row("person", { kind: "dm" }), host)).toBe(host);
  expect(render_(row("beta", { selected: true }), null)).toBeNull();
  expect(
    render_(row("beta", { unread: { ...quiet, attentionCount: 1 } }), null),
  ).toBeNull();
  const starred = render_(row("gamma", { sectionKey: "starred" }), host);
  const open = render_(row("beta", { selected: true }), host);
  const mentioned = render_(
    row("beta", { unread: { ...quiet, attentionCount: 1 } }),
    host,
  );
  const manual = render_(
    row("beta", { unread: { ...quiet, manual: "local-only" } }),
    host,
  );
  for (const element of [starred, open, mentioned, manual]) {
    expect(element).not.toBeNull();
    expect(element).not.toBe(host);
  }
  const marks = (element: typeof open) =>
    render(<>{element}</>).container.querySelectorAll(
      "[data-hide-muted-attention]",
    ).length;
  expect(marks(open)).toBe(0);
  expect(marks(starred)).toBe(0);
  expect(marks(mentioned)).toBe(1);
  expect(marks(manual)).toBe(1);
  f.state.cached = true;
  expect(render_(row("beta"), host)).not.toBeNull();
});

it("keeps the host row mounted as mute and attention change", () => {
  const f = fakeSession("one");
  const render_ = hideMutedRows(fakeRelay(f.session).relay).render;
  if (!render_) throw new Error("missing render");
  const host = <button type="button">host</button>;
  const open = (unread = quiet) => (
    <>{render_(row("beta", { selected: true, unread }), host)}</>
  );
  const view = render(open({ ...quiet, attentionCount: 1 }));
  const button = view.getByRole("button", { name: "host" });
  const dot = () => view.container.querySelector("[data-hide-muted-attention]");
  expect(dot()).toBeInTheDocument();
  view.rerender(open());
  expect(dot()).toBeNull();
  f.state.muted = [];
  view.rerender(open({ ...quiet, attentionCount: 1 }));
  expect(view.getByRole("button", { name: "host" })).toBe(button);
  expect(dot()).toBeNull();
});

it("lists hidden muted channels and follows attention, mutes and sessions", () => {
  const first = fakeSession("one");
  const r = fakeRelay(first.session);
  const rows = mutedRows(r.relay);
  const listener = vi.fn();
  const stop = rows.subscribe(listener);
  const labels = () => rows.snapshot().map(({ label }) => label);
  expect(labels()).toEqual(["Beta"]);
  expect(rows.snapshot()[0]?.icon).toBeTruthy();
  expect(rows.snapshot()).toBe(rows.snapshot());
  listener.mockClear();
  first.state.attention.add("beta");
  first.unreadChanged("beta");
  expect(listener).toHaveBeenCalled();
  expect(labels()).toEqual([]);
  first.state.attention.clear();
  first.unreadChanged("beta");
  expect(labels()).toEqual(["Beta"]);
  first.state.muted = ["gamma"];
  first.preferencesChanged();
  expect(labels()).toEqual([]);
  expect(first.listeners.unread.get("beta")?.size ?? 0).toBe(0);
  first.state.cached = true;
  first.state.muted = ["beta"];
  first.preferencesChanged();
  expect(labels()).toEqual([]);
  const second = fakeSession("two");
  r.replace(second.session);
  expect(labels()).toEqual(["Beta"]);
  for (const set of first.listeners.unread.values()) expect(set.size).toBe(0);
  expect(first.listeners.preferences.size).toBe(0);
  stop();
  expect(second.listeners.preferences.size).toBe(0);
  expect(second.listeners.channels.size).toBe(0);
  for (const set of second.listeners.unread.values()) expect(set.size).toBe(0);
  expect(r.listeners.size).toBe(0);
});
