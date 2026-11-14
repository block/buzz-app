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
  authorId?: string;
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
  const profiles = source();
  const agents = source();
  const reactions = source();
  const channel = new Map<string, ReturnType<typeof source>>();
  const threadsOf = new Map<string, ReturnType<typeof source>>();
  const of = (map: typeof channel, id: string) => {
    const held = map.get(id) ?? source();
    map.set(id, held);
    return held;
  };
  const state = {
    channels: initial.map(summary),
    latest: new Map<
      string,
      { id: string; authorId: string; createdAt: number }
    >(),
    unread: new Map<string, number>(),
    threads: new Map<string, Thread[]>(),
    muted: [] as string[],
    working: [] as string[],
    inbox: [] as unknown[],
    profiles: new Map<string, { name: string; isAgent?: boolean }>(),
    agents: [] as string[],
    reactions: [] as unknown[],
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
      inbox: () => ({ items: state.inbox }),
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
    inboxFeed: {
      ensure,
      reactions: {
        ensure,
        subscribe: reactions.subscribe,
        snapshot: () => ({ status: "ready", items: state.reactions }),
      },
    },
    profiles: {
      subscribe: profiles.subscribe,
      snapshot: () => state.profiles,
      event: (id: string) =>
        state.profiles.has(id)
          ? { content: JSON.stringify(state.profiles.get(id)) }
          : undefined,
    },
    agentChoices: {
      subscribe: agents.subscribe,
      snapshot: () => ({
        identities: state.agents.map((pubkey) => ({ pubkey })),
      }),
    },
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
      state.latest.set(id, { id: `${id}-${createdAt}`, authorId, createdAt });
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
    inbox(items: unknown[]) {
      state.inbox = items;
      inbox.emit();
    },
    profile(id: string, profile: { name: string; isAgent?: boolean }) {
      state.profiles = new Map(state.profiles).set(id, profile);
      profiles.emit();
    },
    agents(ids: string[]) {
      state.agents = ids;
      agents.emit();
    },
    reactions(items: unknown[]) {
      state.reactions = items;
      reactions.emit();
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

const feed: ConversationQuery = { filter: "all", unread: false, home: "team" };

test("a message replaces only its conversation's record and moves its row", () => {
  const { session, message } = fixture([{ id: "a" }, { id: "b" }, { id: "c" }]);
  const index = conversationIndex(session);
  const heard = vi.fn();
  const rows = { a: vi.fn(), c: vi.fn() };
  index.watch(all, heard);
  index.watchRecord("a", rows.a);
  index.watchRecord("c", rows.c);
  expect(index.keys(all)).toEqual(["c:a", "c:b", "c:c"]);
  const a = index.record("a");

  message("c", 10);

  expect(heard).toHaveBeenCalledTimes(1);
  expect(rows.c).toHaveBeenCalledTimes(1);
  expect(rows.a).not.toHaveBeenCalled();
  expect(index.keys(all)).toEqual(["c:c", "c:a", "c:b"]);
  expect(index.record("a")).toBe(a);
  expect(index.record("c")).toMatchObject({ at: 10, unread: true });
});

test("a view keeps its array while its rows and order hold", () => {
  const { session, message, list, state } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  const heard = vi.fn();
  index.watch(all, heard);
  message("a", 10);
  const keys = index.keys(all);
  heard.mockClear();

  message("a", 11);
  // The roster is replaced for every message; its facts are unchanged here.
  list(state.channels.map((channel) => ({ ...channel })));

  expect(heard).not.toHaveBeenCalled();
  expect(index.keys(all)).toBe(keys);
  // Equal queries are one view.
  expect(index.keys({ ...all })).toBe(keys);
});

test("a view nothing watches still answers with the current rows", () => {
  const { session, message } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  expect(index.keys(all)).toEqual(["c:a", "c:b"]);

  message("b", 4);

  expect(index.keys(all)).toEqual(["c:b", "c:a"]);
  const stop = index.watch(all, () => {});
  stop();
  message("a", 5);
  expect(index.keys(all)).toEqual(["c:a", "c:b"]);
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
  const view = (query: Partial<ConversationQuery>) => {
    const stop = index.watch({ ...all, ...query }, () => {});
    const keys = index.keys({ ...all, ...query });
    stop();
    return keys;
  };

  expect(view({})).toEqual(["c:dm", "c:solo", "c:team"]);
  expect(view({ filter: "dms" })).toEqual(["c:dm"]);
  expect(view({ filter: "channels" })).toEqual(["c:team"]);
  expect(view({ unread: true })).toEqual([]);
  expect(view({ unread: true, keep: "dm" })).toEqual(["c:dm"]);

  message("team", 5);
  message("solo", 6);
  expect(view({ unread: true })).toEqual(["c:solo", "c:team"]);
  expect(view({ filter: "waiting" })).toEqual(["c:solo"]);
  expect(view({ sort: "alpha" })).toEqual(["c:dm", "c:solo", "c:team"]);
  expect(view({ home: "team" })).toEqual(["c:team", "c:dm"]);
  expect(view({ home: "solo" })).toEqual(["c:solo"]);
  expect(view({ within: new Set(["dm", "solo"]) })).toEqual(["c:solo", "c:dm"]);

  mute(["team"]);
  expect(view({ unread: true })).toEqual(["c:solo"]);
  work(["solo"]);
  expect(view({ filter: "working" })).toEqual(["c:solo"]);
  expect(view({ filter: "waiting" })).toEqual([]);
});

test("a watched view follows mute, work and Unread one row at a time", () => {
  const { session, message, mute } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  const unread: ConversationQuery = { ...all, unread: true };
  const heard = vi.fn();
  index.watch(unread, heard);
  expect(index.keys(unread)).toEqual([]);

  message("a", 3);
  message("b", 4);
  expect(index.keys(unread)).toEqual(["c:b", "c:a"]);
  expect(heard).toHaveBeenCalledTimes(2);

  mute(["b"]);
  expect(index.keys(unread)).toEqual(["c:a"]);
});

test("threads are events: newest first, unchanged ones keep their identity", () => {
  const { session, thread } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  const threads: ConversationQuery = { filter: "threads", unread: false };
  index.watch(threads, () => {});
  index.watch(all, () => {});
  thread("a", { rootId: "r1", createdAt: 3, unreadCount: 0 });
  const first = index.event("a:r1");

  thread("b", { rootId: "r2", createdAt: 7, unreadCount: 1 });

  expect(index.keys(threads)).toEqual(["e:b:r2", "e:a:r1"]);
  expect(index.keys({ ...threads, unread: true })).toEqual(["e:b:r2"]);
  expect(index.event("a:r1")).toBe(first);
  // A thread you're in moves and marks its channel.
  expect(index.keys(all)).toEqual(["c:b", "c:a"]);
  expect(index.record("b")).toMatchObject({ at: 7, unread: true });
});

test("Team's All is a feed: a channel's row gives way to the event showing its message", () => {
  const { session, thread, message, inbox, reactions } = fixture([
    { id: "a" },
    { id: "b" },
    { id: "dm", channelType: "dm" },
    { id: "solo", channelType: "solo" },
  ]);
  const index = conversationIndex(session);
  index.watch(feed, () => {});
  expect(index.keys(feed)).toEqual(["c:a", "c:b", "c:dm"]);

  // The thread's reply is the newest thing in its channel: one row, the thread.
  thread("a", { rootId: "r1", createdAt: 7, unreadCount: 1 });
  expect(index.keys(feed)).toEqual(["e:a:r1", "c:b", "c:dm"]);

  // A newer top-level message brings the channel's own row back above it.
  message("a", 9);
  expect(index.keys(feed)).toEqual(["c:a", "e:a:r1", "c:b", "c:dm"]);

  // A top-level mention is the channel's latest message: the mention shows it.
  message("b", 12);
  const mention = {
    id: "m1",
    channelId: "b",
    messageId: "b-12",
    authorId: "them",
    preview: "hey",
    createdAt: 12,
    unreadCount: 1,
    manual: false,
  };
  inbox([{ ...mention, mention }]);
  expect(index.keys(feed)).toEqual(["e:m1", "c:a", "e:a:r1", "c:dm"]);
  expect(index.keys({ ...feed, filter: "mentions" })).toEqual(["e:m1"]);

  reactions([
    {
      id: "x",
      channelId: "a",
      message: { id: "mine" },
      createdAt: 10,
      events: [
        {
          id: "e1",
          pubkey: "them",
          authorId: "them",
          content: "+",
          created_at: 10,
          kind: 7,
          tags: [],
        },
      ],
    },
  ]);
  const keys = index.keys(feed);
  expect(keys.map((key) => key.slice(0, 2))).toEqual([
    "e:",
    "r:",
    "c:",
    "e:",
    "c:",
  ]);
  expect(index.reaction((keys[1] as string).slice(2))?.message.id).toBe("mine");
  // Reactions are context: Unread leaves them out.
  expect(index.keys({ ...feed, unread: true })).toEqual([
    "e:m1",
    "c:a",
    "e:a:r1",
  ]);
});

test("a mention that started a thread is one row in the feed, the thread", () => {
  const { session, thread, inbox } = fixture([{ id: "a" }]);
  const index = conversationIndex(session);
  index.watch(feed, () => {});
  thread("a", { rootId: "r1", createdAt: 7, unreadCount: 1 });
  // The inbox names a mention by its channel and group, as it does a thread.
  const mention = {
    id: "a:r1",
    channelId: "a",
    messageId: "r1",
    authorId: "them",
    preview: "hey",
    createdAt: 5,
    unreadCount: 1,
    manual: false,
  };
  inbox([{ ...mention, mention }]);

  expect(index.keys(feed)).toEqual(["e:a:r1"]);
  expect(index.keys({ ...feed, filter: "mentions" })).toEqual(["e:a:r1"]);
});

test("a sender filter keeps what people, or agents, sent", () => {
  const { session, message, thread, profile, agents } = fixture([
    { id: "a" },
    { id: "b" },
    { id: "c" },
  ]);
  const index = conversationIndex(session);
  const from = (sender: "humans" | "agents"): ConversationQuery => ({
    ...feed,
    sender,
  });
  index.watch(from("humans"), () => {});
  index.watch(from("agents"), () => {});
  profile("ann", { name: "Ann" });
  agents(["bot"]);
  message("a", 3, "ann");
  message("b", 4, "bot");
  // Nobody knows who this is yet: neither a person nor an agent.
  message("c", 5, "stranger");
  thread("c", { rootId: "r", createdAt: 6, unreadCount: 0, authorId: "bot" });

  expect(index.keys(from("humans"))).toEqual(["c:a"]);
  expect(index.keys(from("agents"))).toEqual(["e:c:r", "c:b"]);

  profile("stranger", { name: "Sam" });
  thread("c", { rootId: "r2", createdAt: 2, unreadCount: 0, authorId: "ann" });
  expect(index.keys(from("humans"))).toEqual(["c:a", "e:c:r2"]);
});

test("a DM is labelled by its people, and again when their names arrive", () => {
  const { session, profile } = fixture([
    { id: "d", channelType: "dm", name: "", participants: ["ann"] },
  ]);
  const index = conversationIndex(session);
  const heard = vi.fn();
  index.watchRecord("d", heard);
  const before = index.record("d")?.label;

  profile("ann", { name: "Ann" });

  expect(index.record("d")?.label).toBe("Ann");
  expect(before).not.toBe("Ann");
  expect(heard).toHaveBeenCalledTimes(1);
});

test("a conversation that leaves the roster leaves the index", () => {
  const { session, list, message } = fixture([{ id: "a" }, { id: "b" }]);
  const index = conversationIndex(session);
  const heard = vi.fn();
  index.watch(all, heard);

  list([{ id: "a" }]);

  expect(index.keys(all)).toEqual(["c:a"]);
  expect(index.record("b")).toBeUndefined();
  heard.mockClear();
  message("b", 9);
  expect(heard).not.toHaveBeenCalled();
});

test("reading does not load evidence; the first observer does, once", () => {
  const { session, ensure } = fixture([{ id: "a" }]);
  const index = conversationIndex(session);

  expect(index.keys(all)).toEqual(["c:a"]);
  expect(ensure).not.toHaveBeenCalled();

  index.watch(all, () => {});
  index.watchRecord("a", () => {});
  expect(ensure).toHaveBeenCalledTimes(2);
});
