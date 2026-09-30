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
  let membership: "confirmed" | "cached" | "outsider" = "confirmed";
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
        channels: allowed
          ? [
              membership === "confirmed"
                ? { id: channel, members: ["viewer"] }
                : membership === "cached"
                  ? {
                      id: channel,
                      members: ["viewer"],
                      cached: true,
                      readOnly: true,
                    }
                  : { id: channel, members: ["peer"], readOnly: true },
            ]
          : [],
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
    setMembership(next: typeof membership) {
      membership = next;
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
  await vi.waitFor(() =>
    expect(h.unread.sync().writeError).toContain("unknown"),
  );
  expect(h.journal().pending).toHaveLength(1);
  const sent = h.api.write.mock.calls[0]?.[0];
  await h.unread.retrySync();
  expect(h.api.write.mock.calls[1]?.[0]).toEqual(sent);
  expect(h.journal().pending).toEqual([]);
});
it.each(["markThrough", "markChannelRead"] as const)(
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

it.each(["revoke", "clear", "dispose"] as const)(
  "rejects a held manual mark after %s without saving it",
  async (action) => {
    const h = setup();
    await h.unread.ensure();
    const held = h.hold();
    const mark = h.unread.markUnreadLocal(target);
    const rejected = expect(mark).rejects.toThrow();
    try {
      await held.started;
      expect(h.unread.snapshot(target).manual).toBe("local-only");
      if (action === "revoke") h.revoke();
      if (action === "clear") h.owner.clear();
      if (action === "dispose") h.owner.dispose();
      expect(h.unread.snapshot(target).manual).toBe("none");
    } finally {
      // Invalidate even if an earlier paint assertion failed, so cleanup
      // cannot replace that assertion with a resolved-promise rejection error.
      h.owner.dispose();
      held.release();
      await rejected;
    }
    expect(h.journal().manual).toEqual([]);
    expect(h.api.write).not.toHaveBeenCalled();
  },
);

it.each(["revoke", "clear"] as const)(
  "a manual mark queued behind a held read stays unsaved after %s",
  async (action) => {
    const h = setup();
    await h.unread.ensure();
    const held = h.hold();
    const read = h.unread.markThrough(
      { kind: "message", channelId: channel, messageId: h.root },
      h.root,
    );
    const rejected = [expect(read).rejects.toThrow()];
    try {
      await held.started;
      rejected.push(expect(h.unread.markUnreadLocal(target)).rejects.toThrow());
      // The owner stays open, so only the save's own check can refuse it.
      if (action === "revoke") h.revoke();
      else h.owner.clear();
    } finally {
      held.release();
    }
    await Promise.all(rejected);
    expect(h.journal().manual).toEqual([]);
    expect(h.api.write).not.toHaveBeenCalled();
  },
);

it.each(["cached", "outsider"] as const)(
  "%s read-only membership cannot start reading until membership is confirmed",
  async (state) => {
    const h = setup();
    await h.unread.ensure();
    // A lease taken under confirmed membership is fenced once it degrades.
    const earlier = h.unread.reading(channel);
    h.setMembership(state);
    expect(() => h.unread.reading(channel)).toThrow(
      "Reading handle unavailable",
    );
    await earlier.observe([h.root]);
    await Promise.resolve();
    expect(h.journal().pending).toEqual([]);
    expect(h.api.write).not.toHaveBeenCalled();
    earlier.dispose();
    // Positive arm: the same observation reads once membership is confirmed.
    h.setMembership("confirmed");
    const reading = h.unread.reading(channel);
    await reading.observe([h.root]);
    await vi.waitFor(() => expect(h.api.write).toHaveBeenCalledOnce());
    expect(h.api.write.mock.calls[0]?.[0]).toEqual([
      {
        type: "mark_through",
        target: { channel_id: channel },
        message_id: h.root,
      },
    ]);
  },
);

it("message read and unread toggle presentation before the local save or relay acknowledgement", async () => {
  const h = setup();
  const message = {
    kind: "message",
    channelId: channel,
    messageId: h.root,
  } as const;
  h.messages.set(h.root, {
    message_id: h.root,
    status: "unread",
    attention: true,
  });
  h.api.write.mockImplementation(() => new Promise(() => {}));
  const stop = h.unread.subscribe(message, () => {});
  try {
    await vi.waitFor(() =>
      expect(h.unread.attention(channel, h.root).unread).toBe(true),
    );
    const readSave = h.hold();
    const read = h.unread.markThrough(message, h.root);
    await readSave.started;
    // Nothing is saved or sent yet; the read is still being committed locally.
    expect(h.journal().pending).toEqual([]);
    expect(h.api.write).not.toHaveBeenCalled();
    expect(h.unread.attention(channel, h.root).unread).toBe(false);
    readSave.release();
    await read;
    const unreadSave = h.hold();
    const unread = h.unread.markUnreadLocal(message);
    await unreadSave.started;
    expect(h.journal().manual).toEqual([]);
    expect(h.unread.attention(channel, h.root)).toMatchObject({
      unread: true,
      forced: true,
    });
    unreadSave.release();
    await unread;
    expect(h.journal().manual).toEqual([message]);
  } finally {
    stop();
  }
});
