// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { ThreadSnapshot } from "../relay/threads";
import { createHuddleComposerOwner } from "../huddle/composer-owner";
import { createHuddleComposerClient } from "../huddle/composer-client";
import { createPopoutThread } from "./thread";
import type { LiveCallbacks } from "../relay/live";
import { keypair, message, roster, scriptedTransport } from "../relay/testing";

const clean: (() => void)[] = [];
afterEach(() => {
  for (const dispose of clean.splice(0)) dispose();
});
const ROOT = "b".repeat(64);
const VIEWER = "a".repeat(64);

it("loads a seeded session thread on opening before offering replies", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const store = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  clean.push(store.dispose);
  const root = message(viewer, "channel", "Root", 1);
  live.receive([roster(relay, "channel", [viewer.pubkey]), root]);
  const changed = vi.fn();
  const thread = createPopoutThread(store.session, "channel", root.id, changed);
  clean.push(thread.dispose);

  // Seeded rows alone are not a completed thread read. Hold the actual relay
  // request to prove the reply gate stays closed until its verified fold.
  expect(thread.snapshot().root?.id).toBe(root.id);
  expect(thread.writable()).toBe(false);
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  expect(thread.snapshot().status).toBe("loading");
  const read = wire.next();
  expect(read.filters[0]?.ids).toEqual([root.id]);
  expect(read.filters[0]?.["#h"]).toEqual(["channel"]);
  read.respond([root]);
  await vi.waitFor(() => expect(thread.snapshot().status).toBe("ready"));
  expect(thread.rootVerified()).toBe(true);
  expect(thread.writable()).toBe(true);
  expect(changed).toHaveBeenCalled();
});

/** A verified thread root in a stream whose summary carries no roster: the
 * common shape of a channel summary ("absent means unknown"). */
function fixture() {
  const store = createRelaySession(null);
  clean.push(() => store.dispose());
  const channel: { current: ChannelSummary } = {
    current: { id: "channel", name: "Channel", channelType: "stream" },
  };
  const snapshot: { current: ThreadSnapshot } = {
    current: {
      status: "ready",
      error: undefined,
      canLoadMore: false,
      limited: false,
      root: {
        id: ROOT,
        channelId: "channel",
        authorId: VIEWER,
        createdAt: 1,
        content: "Root",
        attachments: [],
        mentions: [],
        reactions: [],
        replyCount: 0,
        participants: [],
      },
      replies: [],
    },
  };
  const reply = vi.fn(() => "accepted-id");
  const session = {
    ...store.session,
    viewer: VIEWER,
    scope: `https://example.test:${VIEWER}`,
    channels: { ...store.session.channels, get: () => channel.current },
    thread: () => ({
      snapshot: () => snapshot.current,
      subscribe: () => () => {},
      refresh: async () => {},
      loadMore: async () => {},
      retarget: async () => "selected" as const,
      dispose: () => {},
    }),
    messages: { ...store.session.messages, reply },
  } as unknown as RelaySession;
  const thread = createPopoutThread(session, "channel", ROOT, () => {});
  clean.push(() => thread.dispose());
  return { session, channel, snapshot, thread, reply };
}

it("offers and admits replies in a verified thread whose summary has no roster", async () => {
  const h = fixture();
  expect(h.thread.rootVerified()).toBe(true);
  expect(h.thread.writable()).toBe(true);
  const owner = createHuddleComposerOwner(
    h.session,
    "channel",
    "channel",
    undefined,
    () => true,
    () => h.thread.rootVerified(),
    undefined,
    ROOT,
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  const session = client.snapshot().session;
  if (!session) throw new Error("composer session");
  await expect(session.messages.reply("channel", ROOT, "hello")).resolves.toBe(
    "accepted-id",
  );
  expect(h.reply).toHaveBeenCalledWith(
    "channel",
    ROOT,
    "hello",
    [],
    [],
    ROOT,
    [],
    {},
  );
});

it("keeps the root, read-only, cached and archived gates", () => {
  const h = fixture();
  for (const flag of ["readOnly", "cached", "archived"] as const) {
    h.channel.current = { ...h.channel.current, [flag]: true };
    expect(h.thread.writable(), flag).toBe(false);
    h.channel.current = {
      id: "channel",
      name: "Channel",
      channelType: "stream",
    };
  }
  expect(h.thread.writable()).toBe(true);
  // An absent, wrong or still-loading root offers no reply box.
  const verified = h.snapshot.current;
  h.snapshot.current = { ...verified, root: undefined };
  expect(h.thread.rootVerified()).toBe(false);
  expect(h.thread.writable()).toBe(false);
  h.snapshot.current = {
    ...verified,
    root: verified.root && { ...verified.root, id: "c".repeat(64) },
  };
  expect(h.thread.writable()).toBe(false);
  h.snapshot.current = { ...verified, status: "loading" };
  expect(h.thread.writable()).toBe(false);
});
