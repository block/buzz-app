// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { ThreadSnapshot } from "../relay/threads";
import { createHuddleComposerOwner } from "../huddle/composer-owner";
import { createHuddleComposerClient } from "../huddle/composer-client";
import { createPopoutThread } from "./thread";

const clean: (() => void)[] = [];
afterEach(() => {
  for (const dispose of clean.splice(0)) dispose();
});
const ROOT = "b".repeat(64);
const VIEWER = "a".repeat(64);

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
