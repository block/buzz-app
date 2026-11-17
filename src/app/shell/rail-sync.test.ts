// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import { RailLayoutConflict } from "../../features/relay/transport";
import type { RelaySession } from "../../features/relay/session";
import {
  clearView,
  clearViewScope,
  readView,
  writeView,
} from "../../shared/view-state";
import { syncRail } from "./rail-sync";

const viewer = "a".repeat(64);
const scope = `wss://relay.test:${viewer}`;
const section = { id: "custom:a", title: "Mine" };
const record = (sections = [section]) => ({
  version: 1,
  order: [],
  sections,
  placements: [],
  pins: [],
  teamExpanded: true,
});
/** A saved record another device can replace. */
function account(payload?: Record<string, unknown>) {
  let head = { payload, createdAt: payload ? 10 : 0 };
  const listeners = new Set<(createdAt?: number) => void>();
  const railLayout = {
    read: vi.fn(async () => head),
    write: vi.fn(async (next: Record<string, unknown>, base: number) => {
      if (base !== head.createdAt) throw new RailLayoutConflict();
      head = { payload: next, createdAt: base + 1 };
      return head.createdAt;
    }),
    changed(listener: (createdAt?: number) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    session: { railLayout } as unknown as RelaySession,
    railLayout,
    head: () => head,
    replace(next: Record<string, unknown>) {
      head = { payload: next, createdAt: head.createdAt + 5 };
      for (const listener of listeners) listener(head.createdAt);
    },
  };
}
const sections = () =>
  readView<{ sections?: unknown }>(scope, "navigation-layout:v2", {}).sections;
const settled = () =>
  vi.waitFor(() =>
    expect(
      readView<{ dirty?: boolean }>(scope, "navigation-sync:v1", {}).dirty,
    ).toBe(false),
  );

beforeEach(() => localStorage.clear());

test("another device's arrangement replaces this one's, and a change here is saved", async () => {
  const saved = account(record());
  const stop = syncRail(saved.session, scope, viewer);
  await settled();
  expect(sections()).toEqual([section]);
  expect(readView(scope, "navigation-team-expanded:v1", false)).toBe(true);
  expect(saved.railLayout.write).not.toHaveBeenCalled();

  writeView(scope, "navigation-team-expanded:v1", false);
  await settled();
  expect(saved.head().payload).toMatchObject({ teamExpanded: false });

  saved.replace(record([]));
  await vi.waitFor(() => expect(sections()).toEqual([]));
  stop();
});

test("a change that was never sent wins over a newer saved arrangement", async () => {
  const saved = account(record([]));
  writeView(scope, "navigation-layout:v2", { sections: [section] });
  writeView(scope, "navigation-sync:v1", { base: 3, dirty: true });
  const stop = syncRail(saved.session, scope, viewer);
  await settled();
  expect(saved.head().payload).toMatchObject({ sections: [section] });
  stop();
});

test("a write that lost to another device reads again and retries", async () => {
  const saved = account(record());
  const stop = syncRail(saved.session, scope, viewer);
  await settled();
  saved.railLayout.read.mockResolvedValueOnce({
    payload: record(),
    createdAt: 1,
  });
  writeView(scope, "navigation-pins:v1", [
    {
      id: "p",
      label: "P",
      kind: "person",
      target: { kind: "person", pubkey: "a".repeat(64) },
    },
  ]);
  await settled();
  expect(saved.railLayout.write).toHaveBeenCalledTimes(2);
  expect(saved.head().payload).toMatchObject({ pins: [{ id: "p" }] });
  stop();
});

test("an account with nothing saved starts from its earlier sections, once", async () => {
  const saved = account();
  let listed: (() => void) | undefined;
  let ready = false;
  Object.assign(saved.session, {
    sidebarPreferences: {
      subscribe: () => () => {},
      snapshot: () => ({
        status: "ready",
        data: {
          sections: [
            { id: "b", name: "Later", order: 2 },
            { id: "a", name: "Work", order: 1 },
          ],
          assignments: { alpha: "a", gone: "missing", left: "a", old: "b" },
        },
      }),
    },
    // The viewer left `left`, and `old` is archived: neither is carried over.
    channels: {
      subscribeList: (listener: () => void) => {
        listed = listener;
        return () => {};
      },
      list: () => ({
        status: listed && ready ? "ready" : "loading",
        channels: [
          { id: "alpha", name: "Alpha" },
          { id: "old", name: "Old", archived: true },
        ],
      }),
    },
  });
  const stop = syncRail(saved.session, scope, viewer);
  // Nothing is carried over before the channel list has loaded.
  await vi.waitFor(() => expect(listed).toBeDefined());
  expect(sections()).toBeUndefined();
  ready = true;
  listed?.();
  await vi.waitFor(() =>
    expect(saved.head().payload).toMatchObject({
      sections: [
        { id: "custom:a", title: "Work" },
        { id: "custom:b", title: "Later" },
      ],
      placements: [
        {
          section: "custom:a",
          entry: {
            id: "channel:alpha",
            label: "Alpha",
            target: {
              channelId: "alpha",
              scope: { viewer },
            },
          },
        },
      ],
    }),
  );
  expect(saved.railLayout.write).toHaveBeenCalledTimes(1);
  stop();
});

test("forgetting what this device kept is not a change to save", async () => {
  const saved = account(record());
  const stop = syncRail(saved.session, scope, viewer);
  await settled();
  clearView(scope, "draft:a", "draft:b");
  clearViewScope(scope);
  await Promise.resolve();
  expect(saved.railLayout.write).not.toHaveBeenCalled();
  expect(saved.head().payload).toEqual(record());
  stop();
});
