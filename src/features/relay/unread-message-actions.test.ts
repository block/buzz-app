import { afterEach, expect, it, vi } from "vitest";
import { verifiedSymbol } from "nostr-tools";
import { createUnread } from "./unread";
import { deferredSidebar, sidebarFixture, sidebarRow } from "./sidebar-testing";
import type { ChannelMessage, ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";

const channel = "01234567-89ab-cdef-0123-456789abcdef";
const target = { kind: "channel", channelId: channel } as const;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});
function setup(count = 2) {
  const bff = sidebarFixture();
  const events = new Map<string, RelayEvent>();
  let rows: ChannelMessage[] = Array.from({ length: count }, (_, i) => {
    const id = i.toString(16).padStart(64, "0");
    const row: ChannelMessage = {
      id,
      channelId: channel,
      authorId: "peer",
      createdAt: i + 1,
      content: `row ${i}`,
      mentions: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      participants: [],
      ...(i ? { replyParentId: "0".repeat(64) } : {}),
    };
    events.set(id, {
      id,
      pubkey: row.authorId,
      created_at: row.createdAt,
      content: row.content,
      kind: 9,
      tags: [["h", channel]],
      sig: "",
      [verifiedSymbol]: true,
    });
    return row;
  });
  let allowed = true;
  const owner = createUnread({
    api: bff.api,
    storage: bff.storage,
    scope: "message-actions",
    viewer: "viewer",
    reader: { read: async () => [] },
    find: (id) => events.get(id),
    channels: {
      list: () => ({
        status: "ready",
        channels: allowed ? [{ id: channel, members: ["viewer"] }] : [],
      }),
      subscribeList: () => () => {},
    } as unknown as ChannelQueries,
  });
  cleanup.push(owner.dispose);
  bff.rows.set(
    channel,
    sidebarRow(channel, {
      latest_message_id: rows[0]?.id ?? null,
      latest_message_at: 1,
    }),
  );
  return {
    ...bff,
    owner,
    unread: owner.capability,
    root: "0".repeat(64),
    changeDescendant(kind: "source" | "edit" | "delete") {
      const child = rows[1];
      if (!child) throw new Error("Missing child");
      const raw = events.get(child.id);
      if (!raw) throw new Error("Missing raw child");
      if (kind === "source")
        events.set(child.id, { ...raw, content: "changed" });
      if (kind === "edit")
        rows = rows.map((row) =>
          row.id === child.id
            ? { ...row, content: "edited", sourceContent: "edited" }
            : row,
        );
      if (kind === "delete") rows = rows.filter((row) => row.id !== child.id);
    },
    drop: () => {
      rows = [];
    },
    revoke() {
      allowed = false;
      owner.purge();
      allowed = true;
    },
    hold() {
      const gate = deferredSidebar<void>(),
        started = deferredSidebar<void>();
      const update = bff.storage.update;
      vi.spyOn(bff.storage, "update").mockImplementationOnce(async (change) => {
        started.resolve();
        await gate.promise;
        return update(change);
      });
      return { started: started.promise, release: () => gate.resolve() };
    },
  };
}
it.each(["revoke", "clear", "dispose"] as const)(
  "rejects held prefix reads after %s without consuming the saved force",
  async (action) => {
    const h = setup();
    await h.unread.markUnreadLocal({
      kind: "message",
      channelId: channel,
      messageId: h.root,
    });
    const before = structuredClone(h.journal());
    const held = h.hold();
    const read = h.unread.markThrough(
      { kind: "message", channelId: channel, messageId: h.root },
      h.root,
    );
    const rejected = expect(read).rejects.toThrow();
    await held.started;
    if (action === "revoke") h.revoke();
    if (action === "clear") h.owner.clear();
    if (action === "dispose") h.owner.dispose();
    held.release();
    await rejected;
    expect(h.journal()).toEqual(before);
    expect(h.api.write).not.toHaveBeenCalled();
  },
);
it("storage rejection preserves force and a clean retry saves exactly the fixed anchor", async () => {
  const h = setup();
  await h.unread.markUnreadLocal({
    kind: "message",
    channelId: channel,
    messageId: h.root,
  });
  vi.spyOn(h.storage, "update").mockRejectedValueOnce(new Error("disk full"));
  await expect(
    h.unread.markThrough(
      { kind: "message", channelId: channel, messageId: h.root },
      h.root,
    ),
  ).rejects.toThrow("disk full");
  expect(h.unread.attention(channel, h.root).forced).toBe(true);
  expect(h.journal().pending).toEqual([]);
  await h.unread.markThrough(
    { kind: "message", channelId: channel, messageId: h.root },
    h.root,
  );
  expect(h.unread.attention(channel, h.root).forced).toBe(false);
  await vi.waitFor(() => expect(h.api.write).toHaveBeenCalled());
});
it("keeps unknown outcomes durable and retries identical operands", async () => {
  const h = setup();
  h.api.write.mockResolvedValueOnce([{ status: "unknown", retryable: true }]);
  await h.unread.markThrough(
    { kind: "message", channelId: channel, messageId: h.root },
    h.root,
  );
  await vi.waitFor(() => expect(h.unread.sync().status).toBe("error"));
  expect(h.journal().pending).toHaveLength(1);
  const sent = h.api.write.mock.calls[0]?.[0];
  await h.unread.retrySync();
  expect(h.api.write.mock.calls[1]?.[0]).toEqual(sent);
  expect(h.journal().pending).toEqual([]);
});
it.each(["markThrough", "clearUnreadLocal", "markChannelRead"] as const)(
  "serializes %s after queued message read and channel unread",
  async (action) => {
    const h = setup();
    await h.unread.ensure();
    const held = h.hold();
    const read = h.unread.markThrough(
      { kind: "message", channelId: channel, messageId: h.root },
      h.root,
    );
    await held.started;
    const unread = h.unread.markUnreadLocal(target);
    const last =
      action === "markThrough"
        ? h.unread.markThrough(target, h.root)
        : action === "clearUnreadLocal"
          ? h.unread.clearUnreadLocal(target)
          : h.unread.markChannelRead(channel);
    held.release();
    await Promise.all([read, unread, last]);
    expect(h.journal().manual).toEqual([]);
  },
);

it.each(["channel", "thread", "message"] as const)(
  "a later %s local-unread wins over queued message and channel read",
  async (kind) => {
    const h = setup();
    await h.unread.ensure();
    const selected =
      kind === "channel"
        ? target
        : kind === "thread"
          ? { kind, channelId: channel, rootId: h.root }
          : { kind, channelId: channel, messageId: h.root };
    const held = h.hold();
    const read = h.unread.markThrough(
      { kind: "message", channelId: channel, messageId: h.root },
      h.root,
    );
    await held.started;
    const channelRead = h.unread.markChannelRead(channel);
    const unread = h.unread.markUnreadLocal(selected);
    held.release();
    await Promise.all([read, channelRead, unread]);
    expect(h.journal().manual).toEqual([selected]);
  },
);
