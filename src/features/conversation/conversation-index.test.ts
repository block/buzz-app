import { expect, test, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  type ConversationQuery,
  conversationIndex,
} from "./conversation-index";

type Thread = {
  rootId: string;
  createdAt: number;
  unreadCount: number;
};

/** The session facts the index reads, each changed and announced by hand. */
function fixture(initial: Partial<ChannelSummary>[]) {
  const source = () => {
    const listeners = new Set<() => void>();
    return {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: () => {
        for (const listener of [...listeners]) listener();
      },
    };
  };
  const list = source();
  const inbox = source();
  const previews = source();
  const preferences = source();
  const activity = source();
  const typing = source();
  const channel = new Map<string, ReturnType<typeof source>>();
  const threadsOf = new Map<string, ReturnType<typeof source>>();
  const of = (map: typeof channel, id: string) => {
    const held = map.get(id) ?? source();
    map.set(id, held);
    return held;
  };
  const state = {
    channels: initial.map(summary),
    latest: new Map<string, { authorId: string; createdAt: number }>(),
    unread: new Map<string, number>(),
    threads: new Map<string, Thread[]>(),
    muted: [] as string[],
    working: [] as string[],
  };
  const ensure = vi.fn(async () => {});
  const session = {
    viewer: "me",
    channels: {
      subscribeList: list.subscribe,
      list: () => ({ status: "ready", channels: state.channels }),
    },
    unread: {
      ensure,
      subscribeInbox: inbox.subscribe,
      inbox: () => ({ items: [] }),
      subscribe: (target: { channelId: string }, listener: () => void) =>
        of(channel, target.channelId).subscribe(listener),
      snapshot: ({ channelId }: { channelId: string }) => ({
        manual: "none",
        observedCount: state.unread.get(channelId) ?? 0,
        attentionCount: 0,
        latestTopLevel: state.latest.get(channelId),
        latestMessage: state.latest.get(channelId),
      }),
      subscribeActivity: (id: string, listener: () => void) =>
        of(threadsOf, id).subscribe(listener),
      activity: (id: string) => ({
        items: (state.threads.get(id) ?? []).map((thread) => ({
          channelId: id,
          latestMessageId: `${thread.rootId}-latest`,
          authorId: "them",
          preview: thread.rootId,
          ...thread,
        })),
      }),
    },
    inboxFeed: { ensure },
    channelPreviews: {
      subscribe: previews.subscribe,
      snapshot: () => new Map(),
    },
    sidebarPreferences: {
      subscribe: preferences.subscribe,
      snapshot: () => ({ cached: false, data: { muted: state.muted } }),
    },
    agentActivity: {
      subscribe: activity.subscribe,
      snapshot: () => ({
        turns: state.working.map((channelId) => ({
          state: "working",
          channelId,
        })),
        typing: [],
      }),
    },
    typing: { subscribe: typing.subscribe, snapshot: () => [] },
  } as unknown as RelaySession;
  return {
    session,
    state,
    ensure,
    message(id: string, createdAt: number, authorId = "them") {
      state.latest.set(id, { authorId, createdAt });
      state.unread.set(id, (state.unread.get(id) ?? 0) + 1);
      of(channel, id).emit();
    },
    thread(id: string, thread: Thread) {
      state.threads.set(id, [...(state.threads.get(id) ?? []), thread]);
      of(threadsOf, id).emit();
    },
    list(next: Partial<ChannelSummary>[]) {
      state.channels = next.map(summary);
      list.emit();
    },
    mute(ids: string[]) {
      state.muted = ids;
      preferences.emit();
    },
    work(ids: string[]) {
      state.working = ids;
      activity.emit();
    },
  };
}

const summary = (fields: Partial<ChannelSummary>) =>
  ({ name: fields.id, channelType: "stream", ...fields }) as ChannelSummary;

const all: ConversationQuery = { filter: "all", unread: false };

test("a message replaces only its conversation's record and reorders the view", () => {
  const { session, message } = fixture([{ id: "a" }, { id: "b" }, { id: "c" }]);
  const index = conversationIndex(session);
  const heard = vi.fn();
  index.subscribe(heard);
  const before = index.view(all);
  expect(before).toEqual(["c:a", "c:b", "c:c"]);
  const a = index.record("a");

  message("c", 10);

  expect(heard).toHaveBeenCalledTimes(1);
  expect(index.view(all)).toEqual(["c:c", "c:a", "c:b"]);
  expect(index.record("a")).toBe(a);
  expect(index.record("c")).toMatchObject({ at: 10, unread: true });
});

test("a view keeps its array while its rows and order hold", () => {
  const { session, message, list, state } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  index.subscribe(() => {});
  message("a", 10);
  const keys = index.view(all);

  message("a", 11);
  // The roster is replaced for every message; its facts are unchanged here.
  list(state.channels.map((channel) => ({ ...channel })));

  expect(index.view(all)).toBe(keys);
  expect(index.view({ ...all })).not.toBe(keys);
});

test("filters, Unread and its kept conversation select from the same records", () => {
  const { session, message, mute, work } = fixture([
    { id: "team" },
    { id: "dm", channelType: "dm" },
    { id: "solo", channelType: "solo" },
    { id: "gone", archived: true },
    { id: "feed", channelType: "workflow" as never },
  ]);
  const index = conversationIndex(session);
  index.subscribe(() => {});
  const view = (query: Partial<ConversationQuery>) =>
    index.view({ ...all, ...query });

  expect(view({})).toEqual(["c:dm", "c:solo", "c:team"]);
  expect(view({ filter: "dms" })).toEqual(["c:dm"]);
  expect(view({ filter: "channels" })).toEqual(["c:team"]);
  expect(view({ unread: true })).toEqual([]);
  expect(view({ unread: true, keep: (id) => id === "dm" })).toEqual(["c:dm"]);

  message("team", 5);
  message("solo", 6);
  expect(view({ unread: true })).toEqual(["c:solo", "c:team"]);
  expect(view({ filter: "waiting" })).toEqual(["c:solo"]);
  expect(view({ sort: "alpha" })).toEqual(["c:dm", "c:solo", "c:team"]);
  expect(view({ include: (channel) => channel.id !== "solo" })).toEqual([
    "c:team",
    "c:dm",
  ]);

  mute(["team"]);
  expect(view({ unread: true })).toEqual(["c:solo"]);
  work(["solo"]);
  expect(view({ filter: "working" })).toEqual(["c:solo"]);
  expect(view({ filter: "waiting" })).toEqual([]);
});

test("threads are events: newest first, unchanged ones keep their identity", () => {
  const { session, thread } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  index.subscribe(() => {});
  const threads: ConversationQuery = { filter: "threads", unread: false };
  thread("a", { rootId: "r1", createdAt: 3, unreadCount: 0 });
  const first = index.event("a:r1");

  thread("b", { rootId: "r2", createdAt: 7, unreadCount: 1 });

  expect(index.view(threads)).toEqual(["e:b:r2", "e:a:r1"]);
  expect(index.view({ ...threads, unread: true })).toEqual(["e:b:r2"]);
  expect(index.event("a:r1")).toBe(first);
  // A thread you're in moves and marks its channel.
  expect(index.view(all)).toEqual(["c:b", "c:a"]);
  expect(index.record("b")).toMatchObject({ at: 7, unread: true });
});

test("a conversation that leaves the roster leaves the index", () => {
  const { session, list, message } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  const heard = vi.fn();
  index.subscribe(heard);

  list([{ id: "a" }]);

  expect(index.view(all)).toEqual(["c:a"]);
  expect(index.record("b")).toBeUndefined();
  heard.mockClear();
  message("b", 9);
  expect(heard).not.toHaveBeenCalled();
});

test("reading does not load evidence; the first observer does, once", () => {
  const { session, ensure } = fixture([{ id: "a" }]);
  const index = conversationIndex(session);

  expect(index.view(all)).toEqual(["c:a"]);
  expect(ensure).not.toHaveBeenCalled();

  index.subscribe(() => {});
  index.subscribe(() => {});
  expect(ensure).toHaveBeenCalledTimes(2);
});
