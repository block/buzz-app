import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../communities/service";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { UnreadSnapshot } from "../relay/unread";
import {
  createCommunityUnreads,
  observeCommunityUnread,
  type CommunityUnread,
} from "./community-unread";

const viewer = "a".repeat(64);
const one = "https://one.example";
const two = "https://two.example";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});

function signal() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}

/** A community session reduced to what the sidebar's unread rows read. */
function fakeSession() {
  let preferences: { status: string; data?: { muted: string[] } } = {
    status: "ready",
    data: { muted: [] },
  };
  let channels: { id: string; members: string[]; huddle?: true }[] = [];
  const unread = new Map<string, Partial<UnreadSnapshot>>();
  const prefs = signal(),
    list = signal(),
    rows = signal();
  const session = {
    sidebarPreferences: {
      snapshot: () => preferences,
      subscribe: prefs.subscribe,
    },
    channels: {
      list: () => ({ channels }),
      subscribeList: list.subscribe,
    },
    unread: {
      snapshot: ({ channelId }: { channelId: string }) => ({
        manual: "none",
        observedCount: 0,
        attentionCount: 0,
        ...unread.get(channelId),
      }),
      // One listener per channel, as the real capability holds them.
      subscribe: (_target: unknown, listener: () => void) =>
        rows.subscribe(() => listener()),
    },
  } as unknown as RelaySession;
  return {
    session,
    rows,
    join(...ids: string[]) {
      channels = ids.map((id) => ({ id, members: [viewer] }));
      list.emit();
    },
    set(id: string, snapshot: Partial<UnreadSnapshot>) {
      unread.set(id, snapshot);
      rows.emit();
    },
    preferences(next: typeof preferences) {
      preferences = next;
      prefs.emit();
    },
  };
}

function observe(
  fake: ReturnType<typeof fakeSession>,
  allows?: (id: string) => boolean,
) {
  const publish = vi.fn<(state: CommunityUnread | undefined) => void>();
  const gates = allows && {
    allows: (target: { channelId?: string }) => allows(target.channelId ?? ""),
    subscribe: () => () => {},
  };
  cleanups.push(
    observeCommunityUnread(
      fake.session,
      viewer,
      one,
      publish,
      gates as Parameters<typeof observeCommunityUnread>[4],
    ),
  );
  return () => publish.mock.lastCall?.[0];
}

it("counts items that need you and reports ordinary unread as a dot", () => {
  const fake = fakeSession();
  const state = observe(fake);
  fake.join("a", "b");
  expect(state()).toEqual({ unread: false, attention: 0 });
  fake.set("a", { observedCount: 3 });
  expect(state()).toEqual({ unread: true, attention: 0 });
  fake.set("b", { observedCount: 2, attentionCount: 2 });
  expect(state()).toEqual({ unread: true, attention: 2 });
});

it("follows the sidebar row a visit quieted, and keeps manual unread", () => {
  const fake = fakeSession();
  const state = observe(fake);
  fake.join("a");
  fake.set("a", {
    observedCount: 4,
    attentionCount: 1,
    row: { observedCount: 0, attentionCount: 0, threadCount: 0 },
  });
  expect(state()).toEqual({ unread: false, attention: 0 });
  fake.set("a", { observedCount: 0, manual: "local-only" });
  expect(state()).toEqual({ unread: true, attention: 0 });
});

it("leaves out muted channels and channels notification settings exclude", () => {
  const fake = fakeSession();
  const state = observe(fake, (id) => id !== "quiet");
  fake.join("muted", "quiet", "open");
  fake.preferences({ status: "ready", data: { muted: ["muted"] } });
  fake.set("muted", { observedCount: 5, attentionCount: 5 });
  fake.set("quiet", { observedCount: 5, attentionCount: 5 });
  expect(state()).toEqual({ unread: false, attention: 0 });
  fake.set("open", { observedCount: 1 });
  expect(state()).toEqual({ unread: true, attention: 0 });
});

it("is unknown, never all read, until confirmed mutes are known", () => {
  const fake = fakeSession();
  fake.preferences({ status: "loading" });
  const state = observe(fake);
  fake.join("a");
  fake.set("a", { observedCount: 1 });
  expect(state()).toBeUndefined();
  fake.preferences({ status: "unsupported" });
  expect(state()).toEqual({ unread: true, attention: 0 });
});

it("stops observing every channel when disposed", () => {
  const fake = fakeSession();
  const publish = vi.fn();
  const stop = observeCommunityUnread(fake.session, viewer, one, publish);
  fake.join("a", "b");
  expect(fake.rows.size).toBe(2);
  stop();
  expect(fake.rows.size).toBe(0);
  publish.mockClear();
  fake.set("a", { observedCount: 1 });
  fake.join("a", "b", "c");
  expect(publish).not.toHaveBeenCalled();
});

it("keys every open community's unread and never opens a session itself", () => {
  const [first, second] = [fakeSession(), fakeSession()];
  const sessions = new Map(
    (
      [
        [one, first],
        [two, second],
      ] as const
    ).map(([id, fake]) => {
      const changes = signal();
      const relay = {
        snapshot: () => ({ status: "ready", viewer, session: fake.session }),
        subscribe: changes.subscribe,
      } as unknown as RelayData;
      return [id, { fake, relay }] as const;
    }),
  );
  let open = new Set([one]);
  const client = signal();
  let snapshot = {
    viewer,
    selected: one,
    memberships: [{ id: one }, { id: two }],
  };
  const retained = vi.fn((id: string) =>
    open.has(id) ? sessions.get(id)?.relay : undefined,
  );
  const communities = {
    snapshot: () => snapshot,
    subscribe: client.subscribe,
    retained,
    relay: { subscribe: () => () => {} },
  } as unknown as Communities;
  const unreads = createCommunityUnreads(communities);
  cleanups.push(unreads.dispose);
  first.join("a");
  first.set("a", { observedCount: 1, attentionCount: 1 });
  expect([...unreads.snapshot()]).toEqual([
    [one, { unread: true, attention: 1 }],
  ]);
  // A visited community's session is picked up when the membership changes.
  open = new Set([one, two]);
  snapshot = { ...snapshot, selected: two };
  client.emit();
  second.join("b");
  second.set("b", { observedCount: 2 });
  expect(unreads.snapshot().get(two)).toEqual({ unread: true, attention: 0 });
  // Leaving drops it.
  snapshot = { ...snapshot, selected: one, memberships: [{ id: one }] };
  client.emit();
  expect([...unreads.snapshot().keys()]).toEqual([one]);
  expect(second.rows.size).toBe(0);
});
