import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../communities/service";
import { createRelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import { readJournal, type ReadJournal } from "../relay/read-state-storage";
import type {
  SidebarDecoder,
  SidebarMuteMutator,
} from "../relay/sidebar-preferences";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { bindUnreadIndicator, type IndicatorGates } from "./indicator-unread";
import type { BadgeActivity } from "./preferences";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});
function setup(
  sidebar?: Readonly<{
    decode: SidebarDecoder;
    write: SidebarMuteMutator;
  }>,
) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  let incoming = (_events: readonly RelayEvent[]) => {};
  let journal: ReadJournal | undefined;
  const query = vi.fn(async () => [] as RelayEvent[]);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      readState: {
        decode: async () => [],
        sign: async () => {
          throw new Error("No publication in this fixture");
        },
        publish: async () => {},
      },
      ...(sidebar
        ? {
            decodeSidebarPreferences: sidebar.decode,
            writeSidebarMute: sidebar.write,
          }
        : {}),
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
      // Local read intent is the contract; no publication lease is acquired.
      readPublisherLock: async () => {},
    },
  );
  cleanups.push(owner.dispose);
  const client = {
    viewer: viewer.pubkey as string | undefined,
    selected: "https://one.example" as string | null,
    memberships: [{ id: "https://one.example" }],
  };
  const relayState = {
    status: "ready",
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const communities = {
    snapshot: () => client,
    subscribe,
    relay: { snapshot: () => relayState, subscribe },
  } as unknown as Communities;
  const project = vi.fn();
  const bind = (gates?: IndicatorGates) => {
    const stop = bindUnreadIndicator(communities, project, gates);
    cleanups.push(stop);
    return stop;
  };
  return {
    ...owner,
    viewer,
    peer,
    relay,
    client,
    relayState,
    project,
    query,
    bind,
    notify() {
      for (const fn of listeners) fn();
    },
    emit(events: readonly RelayEvent[]) {
      incoming(events);
    },
    grant(id = "room", time = 10) {
      incoming([
        roster(relay, id, [viewer.pubkey], time),
        metadata(relay, id, id, time),
      ]);
    },
  };
}
const target = { kind: "channel", channelId: "room" } as const;

function badgePolicy(initial: BadgeActivity = "mentions-and-dms") {
  let activity = initial;
  const listeners = new Set<() => void>();
  return {
    allows: () => true,
    badgeActivity: () => activity,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    select(next: BadgeActivity) {
      activity = next;
      for (const listener of listeners) listener();
    },
  };
}

it("filters ordinary posts and followed replies, and immediately reprojects preference changes", async () => {
  const h = setup();
  h.grant();
  const policy = badgePolicy("all");
  h.bind(policy);
  h.emit([message(h.peer, "room", "ordinary", 11)]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  policy.select("mentions-and-dms");
  expect(h.project).toHaveBeenLastCalledWith(false);
  const root = message(h.viewer, "room", "my thread", 12);
  h.emit([
    root,
    message(h.peer, "room", "reply", 13, [["e", root.id, "", "reply"]]),
  ]);
  expect(h.project).toHaveBeenLastCalledWith(false);
  expect(h.session.unread.snapshot(target).attentionCount).toBe(1);
  h.emit([
    message(h.peer, "room", "reply sent to channel", 14, [
      ["e", root.id, "", "reply"],
      ["broadcast", "1"],
    ]),
  ]);
  expect(h.project).toHaveBeenLastCalledWith(false);
  await h.session.unread.markUnreadLocal(target);
  expect(h.project).toHaveBeenLastCalledWith(false);
  policy.select("all");
  expect(h.project).toHaveBeenLastCalledWith(true);
  expect(h.query).not.toHaveBeenCalled();
});

it.each(["post", "reply"])(
  "projects an unread %s mention and follows row visibility and reading",
  async (kind) => {
    const h = setup();
    h.grant();
    h.bind(badgePolicy());
    const root = message(h.peer, "room", "root", 11);
    const tags = [["p", h.viewer.pubkey]];
    if (kind !== "post") tags.push(["e", root.id, "", "reply"]);
    const mention = message(h.peer, "room", "mention", 12, tags);
    h.emit([root, mention]);
    expect(h.project).toHaveBeenLastCalledWith(true);
    expect(h.session.unread.snapshot(target).mentionCount).toBe(1);
    await h.session.unread.enterChannel("room");
    expect(h.project).toHaveBeenLastCalledWith(false);
    expect(h.session.unread.snapshot(target).mentionCount).toBe(1);
    expect(h.session.unread.snapshot(target).row?.mentionCount).toBe(0);
    h.session.unread.leaveChannel("room");
    const newer = message(h.peer, "room", "later mention", 13, tags);
    h.emit([newer]);
    expect(h.project).toHaveBeenLastCalledWith(true);
    await h.session.unread.markChannelRead("room");
    expect(h.project).toHaveBeenLastCalledWith(false);
    expect(h.query).not.toHaveBeenCalled();
  },
);

it("includes DMs without requiring a mention, but excludes ordinary Solo activity", async () => {
  const h = setup();
  h.emit([
    roster(h.relay, "solo", [h.viewer.pubkey], 10),
    metadata(h.relay, "solo", "Solo", 10, [["t", "solo"]]),
    message(h.peer, "solo", "agent completion", 11),
    roster(h.relay, "dm", [h.viewer.pubkey, h.peer.pubkey], 10),
    metadata(h.relay, "dm", "DM", 10, [["t", "dm"]]),
  ]);
  h.bind(badgePolicy());
  expect(h.project).toHaveBeenLastCalledWith(false);
  const direct = message(h.peer, "dm", "direct message", 12);
  h.emit([direct]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.session.unread.markThrough(
    { kind: "channel", channelId: "dm" },
    direct.id,
  );
  expect(h.project).toHaveBeenLastCalledWith(false);
});

it("retains mute, access and agent-audience exclusions in mentions-and-DMs mode", async () => {
  const h = setup({
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    write: async ({ muted }) => (muted ? ["room"] : []),
  });
  h.grant();
  await h.session.sidebarPreferences.ensure();
  h.bind(badgePolicy());
  h.emit([
    message(h.peer, "room", "coordination", 11, [
      ["p", h.viewer.pubkey],
      ["audience", "agents"],
    ]),
  ]);
  expect(h.project).toHaveBeenLastCalledWith(false);
  h.emit([message(h.peer, "room", "mention", 12, [["p", h.viewer.pubkey]])]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.session.sidebarPreferences.setMute("room", true);
  expect(h.project).toHaveBeenLastCalledWith(false);
  await h.session.sidebarPreferences.setMute("room", false);
  expect(h.project).toHaveBeenLastCalledWith(true);
  h.emit([roster(h.relay, "room", [], 13)]);
  expect(h.project).toHaveBeenLastCalledWith(false);
});
it("starts clear for unknown evidence; projects arrivals and explicit read clearing without new reads", async () => {
  const h = setup();
  h.grant();
  h.bind();
  expect(h.project.mock.calls).toEqual([[false]]);
  expect(h.session.unread.snapshot(target).observedCount).toBeNull();
  const row = message(h.peer, "room", "arrival", 11);
  h.emit([row]);
  expect(h.project.mock.calls).toEqual([[false], [true]]);
  await h.session.unread.markThrough(target, row.id);
  expect(h.project.mock.calls).toEqual([[false], [true], [false]]);
  expect(h.query).not.toHaveBeenCalled();
});
it("restores existing unread at binding startup, including thread-only activity and manual unread", async () => {
  const h = setup();
  h.grant();
  const root = message(h.viewer, "room", "my thread", 11);
  const reply = message(h.peer, "room", "reply", 12, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply]);
  h.bind();
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.session.unread.markThrough(
    { kind: "thread", channelId: "room", rootId: root.id },
    reply.id,
  );
  expect(h.project).toHaveBeenLastCalledWith(false);
  await h.session.unread.markUnreadLocal(target);
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.session.unread.markThrough(target, root.id);
  expect(h.project).toHaveBeenLastCalledWith(false);
});
it("uses all accessible channels, ignores own/auxiliary traffic, and clears on deletion or access loss", () => {
  const h = setup();
  h.bind();
  h.grant();
  h.emit([message(h.viewer, "room", "own", 11)]);
  expect(h.project.mock.calls).toEqual([[false]]);
  h.grant("second");
  const row = message(h.peer, "second", "unread elsewhere", 12);
  h.emit([row]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  h.emit([
    signed(h.peer, {
      kind: 5,
      content: "",
      tags: [
        ["h", "second"],
        ["e", row.id],
      ],
    }),
  ]);
  expect(h.project).toHaveBeenLastCalledWith(false);
  h.emit([message(h.peer, "room", "private", 13)]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  h.emit([roster(h.relay, "room", [], 14)]);
  expect(h.project).toHaveBeenLastCalledWith(false);
});
it.each(["personal", "viewer", "disconnected", "membership"])(
  "clears and detaches old evidence on %s transition",
  (transition) => {
    const h = setup();
    h.grant();
    h.bind();
    h.emit([message(h.peer, "room", "before switch", 11)]);
    if (transition === "personal") h.client.selected = null;
    if (transition === "viewer") h.client.viewer = keypair().pubkey;
    if (transition === "disconnected") h.relayState.status = "disconnected";
    if (transition === "membership") h.client.memberships = [];
    h.notify();
    expect(h.project).toHaveBeenLastCalledWith(false);
    const calls = h.project.mock.calls.length;
    h.emit([message(h.peer, "room", "retired session", 12)]);
    expect(h.project).toHaveBeenCalledTimes(calls);
  },
);
it("retargets an already-open community and ignores the prior session after switching and teardown", () => {
  const h = setup(),
    other = setup();
  h.grant();
  other.grant();
  const stop = h.bind();
  h.emit([message(h.peer, "room", "first community", 11)]);
  h.client.selected = "https://two.example";
  h.client.memberships.push({ id: h.client.selected });
  h.client.viewer = other.viewer.pubkey;
  h.relayState.viewer = other.viewer.pubkey;
  h.relayState.session = other.session;
  h.notify();
  expect(h.project).toHaveBeenLastCalledWith(false);
  h.emit([message(h.peer, "room", "background community", 12)]);
  expect(h.project).toHaveBeenLastCalledWith(false);
  other.emit([message(other.peer, "room", "selected community", 13)]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  stop();
  expect(h.project).toHaveBeenLastCalledWith(false);
  const calls = h.project.mock.calls.length;
  other.emit([message(other.peer, "room", "after stop", 14)]);
  h.notify();
  stop();
  expect(h.project).toHaveBeenCalledTimes(calls);
});

it.each(["huddle", "metadataPending"] as const)(
  "excludes %s channels from the Dock indicator",
  (flag) => {
    const h = setup();
    h.grant();
    const original = h.session;
    h.relayState.session = {
      ...original,
      channels: {
        ...original.channels,
        list: () => ({
          ...original.channels.list(),
          channels: original.channels
            .list()
            .channels.map((c) => ({ ...c, [flag]: true })),
        }),
      },
    };
    h.bind();
    h.emit([message(h.peer, "room", "arrival", 11)]);
    expect(h.session.unread.snapshot(target).observedCount).toBe(1);
    expect(h.project.mock.calls).toEqual([[false]]);
  },
);

it("removes muted channel activity from the Dock indicator without marking it read", async () => {
  const h = setup({
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    write: async ({ muted }) => (muted ? ["room"] : []),
  });
  h.grant();
  await h.session.sidebarPreferences.ensure();
  h.bind();
  const row = message(h.peer, "room", "arrival", 11);
  h.emit([row]);
  expect(h.project).toHaveBeenLastCalledWith(true);

  await h.session.sidebarPreferences.setMute("room", true);
  expect(h.project).toHaveBeenLastCalledWith(false);
  expect(h.session.unread.snapshot(target).observedCount).toBe(1);

  await h.session.unread.markThrough(target, row.id);
  h.emit([message(h.peer, "room", "muted arrival", 12)]);
  expect(h.session.unread.snapshot(target).observedCount).toBe(1);
  expect(h.project).toHaveBeenLastCalledWith(false);

  await h.session.unread.markUnreadLocal(target);
  expect(h.project).toHaveBeenLastCalledWith(false);

  await h.session.sidebarPreferences.setMute("room", false);
  expect(h.project).toHaveBeenLastCalledWith(true);
});

it("follows the sidebar row: opening a channel clears the Dock without reading it", () => {
  const h = setup();
  h.grant();
  h.bind();
  h.emit([message(h.peer, "room", "arrival", 11)]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  void h.session.unread.enterChannel("room");
  expect(h.project).toHaveBeenLastCalledWith(false);
  expect(h.session.unread.snapshot(target).observedCount).toBe(1);
  h.session.unread.leaveChannel("room");
  h.emit([message(h.peer, "room", "later", 12)]);
  expect(h.project).toHaveBeenLastCalledWith(true);
});

it("stays off for coordination between agents and lights for the next message to everyone", () => {
  const h = setup();
  h.bind();
  h.grant();
  h.emit([message(h.peer, "room", "Progress", 11, [["audience", "agents"]])]);
  expect(h.project.mock.calls).toEqual([[false]]);
  h.emit([message(h.peer, "room", "Done", 12)]);
  expect(h.project).toHaveBeenLastCalledWith(true);
});

it("counts only conversations the notification gates allow and follows gate changes", () => {
  const h = setup();
  h.grant();
  let allowed = new Set<string>();
  const gateListeners = new Set<() => void>();
  const seen: unknown[] = [];
  h.bind({
    allows(target) {
      seen.push(target);
      return target.kind === "conversation" && allowed.has(target.channelId);
    },
    subscribe(listener) {
      gateListeners.add(listener);
      return () => void gateListeners.delete(listener);
    },
  });
  h.emit([message(h.peer, "room", "held", 11)]);
  expect(h.project.mock.calls).toEqual([[false]]);
  expect(seen[0]).toEqual({
    version: 1,
    kind: "conversation",
    scope: { viewer: h.viewer.pubkey, communityOrigin: "https://one.example" },
    channelId: "room",
  });
  allowed = new Set(["room"]);
  for (const listener of gateListeners) listener();
  expect(h.project).toHaveBeenLastCalledWith(true);
  allowed = new Set();
  for (const listener of gateListeners) listener();
  expect(h.project).toHaveBeenLastCalledWith(false);
});

it("relights the Dock projection for attention arriving during a background visit", async () => {
  const h = setup();
  h.grant();
  h.bind();
  h.emit([message(h.peer, "room", "before", 11)]);
  await h.session.unread.enterChannel("room");
  expect(h.project).toHaveBeenLastCalledWith(false);
  h.session.unread.setChannelActive("room", false);
  h.emit([
    message(h.peer, "room", "background mention", 10, [["p", h.viewer.pubkey]]),
  ]);
  expect(h.project).toHaveBeenLastCalledWith(true);
  h.session.unread.leaveChannel("room");
  expect(h.project).toHaveBeenLastCalledWith(true);
});
