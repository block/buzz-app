import { expect, it, vi, assert } from "vitest";
import { createRelaySession } from "../relay/session";
import { createHuddleDiscussion } from "./discussion";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";

function harness() {
  const owner = createRelaySession(null),
    viewer = "ab".repeat(32),
    room = "room",
    parent = "parent";
  let metadata: ChannelSummary = {
    id: room,
    name: "Huddle",
    huddle: true,
    parentChannelId: parent,
  };
  let rows: ChannelMessage[] = [];
  const send = vi.fn(() => "id"),
    retry = vi.fn((_id: string, _allowed: () => boolean) => {}),
    dismiss = vi.fn(async () => {});
  const listeners = new Set<() => void>();
  const pending = {
    event: {
      id: "failed",
      pubkey: viewer,
      created_at: 1,
      kind: 9,
      tags: [["h", room]],
      content: "Hello",
    },
    delivery: "failed" as const,
  };
  const session = {
    ...owner.session,
    viewer,
    messages: { ...owner.session.messages, send },
    outbox: {
      subscribe: () => () => {},
      observeSend: () => () => {},
      supports: () => true,
      ready: async () => {},
      send: () => "id",
      recover: async () => {},
      acknowledge: async () => {},
      snapshot: () => [pending],
      retry,
      dismiss,
    },
    channels: {
      ...owner.session.channels,
      get: () => metadata,
      resolve: async () => {},
      ensure: () => {},
      subscribeWindow: (_id: string, fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      window: () => ({
        channelId: room,
        status: "ready" as const,
        rows,
        loadingOlder: false,
        hasMore: true,
        error: undefined,
      }),
    },
  };
  const discussion = createHuddleDiscussion(session, room, parent, vi.fn());
  return {
    owner,
    discussion,
    send,
    retry,
    dismiss,
    metadata: (next: ChannelSummary) => {
      metadata = next;
    },
    rows: (next: ChannelMessage[]) => {
      rows = next;
    },
    dispose: () => {
      discussion.dispose();
      owner.dispose();
    },
  };
}
it("only reads and sends to a verified Huddle belonging to this parent", async () => {
  const h = harness();
  h.metadata({ id: "room", name: "Ordinary channel" });
  try {
    await vi.waitFor(() =>
      expect(h.discussion.snapshot().status).toBe("error"),
    );
    await h.discussion.send("Wrong destination");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.discussion.snapshot().rows).toEqual([]);
  } finally {
    h.dispose();
  }
});
it("bounds native presentation and offers room-bound failure recovery", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.discussion.snapshot().writable).toBe(true));
    h.rows(
      Array.from({ length: 513 }, (_, i) => ({
        id: String(i),
        channelId: "room",
        authorId: "ab".repeat(32),
        createdAt: i,
        content: "message",
        mentions: [],
        attachments: [],
        reactions: [],
        participants: [],
        replyCount: 0,
      })),
    );
    expect(h.discussion.snapshot()).toMatchObject({
      historyLimited: true,
      hasMore: false,
    });
    expect(h.discussion.snapshot().rows).toHaveLength(200);
    await h.discussion.send("Hello");
    expect(h.send).toHaveBeenCalledWith("room", "Hello");
    h.discussion.recover("other");
    expect(h.retry).not.toHaveBeenCalled();
    h.discussion.recover("failed");
    expect(h.retry).toHaveBeenCalledWith("failed", expect.any(Function));
    h.discussion.recover("failed", true);
    expect(h.dismiss).toHaveBeenCalledWith("failed");
    const retryAllowed = h.retry.mock.calls[0]?.[1];
    assert.exists(retryAllowed);
    h.discussion.dispose();
    // An accepted delivery outlives its panel, but still checks current room access.
    expect(retryAllowed()).toBe(true);
    h.metadata({
      id: "room",
      name: "Huddle",
      huddle: true,
      parentChannelId: "parent",
      archived: true,
    });
    expect(retryAllowed()).toBe(false);
    await h.discussion.send("Late");
    expect(h.send).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});
