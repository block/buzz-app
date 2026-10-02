import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { createUnread } from "./unread";
import {
  deferredSidebar,
  sidebarAccount,
  sidebarFixture,
  sidebarRow,
} from "./sidebar-testing";
import type { MessageReadState, UnreadReason } from "./sidebar-api";
import type { InboxSnapshot } from "./inbox";
import { keypair, message, metadata, roster, signed } from "./testing";
import { matchesEvent } from "./projection";
import type { LiveCallbacks } from "./live";
import type { ReadFilter, RelayEvent } from "./events";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const other = "11234567-89ab-cdef-0123-456789abcdef";
const target = { kind: "channel", channelId: channel } as const;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.useRealTimers();
});
function setup(initialGrant = true) {
  const bff = sidebarFixture(),
    viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  let live!: LiveCallbacks;
  const query = vi.fn(
    async (_filters: readonly ReadFilter[]) => [] as RelayEvent[],
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      sidebarApi: bff.api,
      query,
      media: () => undefined,
      subscribe(c) {
        live = c;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { sidebarStorage: bff.storage },
  );
  cleanups.push(owner.dispose);
  const grant = (id = channel, members = [viewer.pubkey], time = 10) =>
    live.receive([
      roster(relay, id, members, time),
      metadata(relay, id, id, time),
    ]);
  if (initialGrant) grant();
  const unread = owner.session.unread;
  return {
    ...owner,
    bff,
    viewer,
    peer,
    relay,
    query,
    grant,
    unread,
    emit: (events: readonly RelayEvent[], phase?: "live" | "replay") =>
      live.receive(events, phase ? { phase, channelId: channel } : undefined),
    snapshot: () => unread.snapshot(target),
  };
}
it("counts only BFF responses, never ingested history; preserves uncertainty and stable selectors", async () => {
  const h = setup();
  const before = h.snapshot();
  h.emit([message(h.peer, channel, "history", 11)]);
  expect(h.snapshot()).toBe(before);
  expect(before.unread).toEqual({ status: "unknown" });
  expect(h.bff.api.contexts).not.toHaveBeenCalled();
  h.bff.rows.set(
    channel,
    sidebarRow(channel, {
      unread: { status: "at_least", value: 9 },
      attention: { status: "unknown" },
    }),
  );
  await h.unread.ensure();
  expect(h.snapshot()).toMatchObject({
    unread: { status: "at_least", value: 9 },
    attention: { status: "unknown" },
  });
  expect(h.snapshot()).toBe(h.snapshot());
  expect(h.session.channels.window(channel).rows).toEqual([]);
});
it("retains message context only while subscribed, including replies without hydrated roots", async () => {
  const h = setup();
  const row = message(h.peer, channel, "reply", 12, [
    ["e", "a".repeat(64), "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  h.emit([row]);
  h.bff.messages.set(row.id, {
    message_id: row.id,
    status: "unread",
    reason: "conversation",
  });
  const stop = h.unread.subscribe(
    { kind: "message", channelId: channel, messageId: row.id },
    () => {},
  );
  await vi.waitFor(() =>
    expect(h.unread.attention(channel, row.id).status).toBe("eligible"),
  );
  expect(h.bff.api.contexts.mock.calls[0]?.[0]).toEqual([
    {
      target: { channel_id: channel, root_id: "a".repeat(64) },
      message_ids: [row.id],
    },
  ]);
  stop();
  h.bff.api.contexts.mockClear();
  await h.unread.refresh();
  expect(h.bff.api.contexts).not.toHaveBeenCalled();
});
it("retargets retained message demand when a signed parent reveals the canonical root", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 10);
  const parent = message(h.peer, channel, "parent", 11, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  const child = message(h.peer, channel, "child", 12, [
    ["e", parent.id, "", "reply"],
  ]);
  h.emit([child]);
  h.bff.messages.set(child.id, {
    message_id: child.id,
    status: "unread",
    reason: "conversation",
  });
  const selected = {
    kind: "message",
    channelId: channel,
    messageId: child.id,
  } as const;
  const listener = vi.fn();
  const stop = h.unread.subscribe(selected, listener);
  await h.unread.refresh();
  expect(h.unread.attention(channel, child.id).status).toBe("eligible");
  expect(h.bff.api.contexts.mock.calls.at(-1)?.[0]).toEqual([
    {
      target: { channel_id: channel, root_id: parent.id },
      message_ids: [child.id],
    },
  ]);
  h.bff.api.contexts.mockClear();
  listener.mockClear();
  h.emit([parent, root]);
  await h.unread.refresh();
  expect(h.bff.api.contexts).toHaveBeenCalled();
  for (const [queries] of h.bff.api.contexts.mock.calls)
    expect(queries).toEqual([
      {
        target: { channel_id: channel, root_id: root.id },
        message_ids: [child.id],
      },
    ]);
  expect(listener).toHaveBeenCalled();
  expect(h.unread.attention(channel, child.id)).toMatchObject({
    status: "eligible",
    rootId: root.id,
  });
  expect(h.unread.snapshot(selected).unread).toEqual({
    status: "exact",
    value: 1,
  });
  stop();
  h.bff.api.contexts.mockClear();
  await h.unread.refresh();
  expect(h.bff.api.contexts).not.toHaveBeenCalled();
});
it("retargets retained demand after verified parent evidence is evicted, preserving shared consumers", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 10);
  const parent = message(h.peer, channel, "parent", 11, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  const child = message(h.peer, channel, "child", 12, [
    ["e", parent.id, "", "reply"],
  ]);
  const found = new Map(
    [root, parent, child].map((event) => [event.id, event]),
  );
  const owner = createUnread({
    api: h.bff.api,
    storage: h.bff.storage,
    scope: "mutable-evidence",
    channels: h.session.channels,
    viewer: h.viewer.pubkey,
    reader: { read: async () => [] },
    find: (id) => found.get(id),
  });
  cleanups.push(owner.dispose);
  const selected = {
    kind: "message",
    channelId: channel,
    messageId: child.id,
  } as const;
  h.bff.messages.set(child.id, {
    message_id: child.id,
    status: "unread",
    reason: "conversation",
  });
  const stop = owner.capability.subscribe(selected, () => {});
  const stopShared = owner.capability.subscribe(selected, () => {});
  await owner.capability.refresh();
  expect(h.bff.api.contexts.mock.calls.at(-1)?.[0]).toEqual([
    {
      target: { channel_id: channel, root_id: root.id },
      message_ids: [child.id],
    },
  ]);
  found.delete(parent.id);
  h.bff.api.contexts.mockClear();
  owner.accept([child]);
  await owner.capability.refresh();
  expect(h.bff.api.contexts.mock.calls.at(-1)?.[0]).toEqual([
    {
      target: { channel_id: channel, root_id: parent.id },
      message_ids: [child.id],
    },
  ]);
  expect(owner.capability.attention(channel, child.id).status).toBe("eligible");
  stop();
  h.bff.api.contexts.mockClear();
  await owner.capability.refresh();
  expect(h.bff.api.contexts.mock.calls.at(-1)?.[0]).toEqual([
    {
      target: { channel_id: channel, root_id: parent.id },
      message_ids: [child.id],
    },
  ]);
  stopShared();
  h.bff.api.contexts.mockClear();
  await owner.capability.refresh();
  expect(h.bff.api.contexts).not.toHaveBeenCalled();
});
it.each(["unsubscribe", "revoke"])(
  "does not publish held context results after %s",
  async (action) => {
    const h = setup();
    const child = message(h.peer, channel, "child", 12, [
      ["e", "a".repeat(64), "", "reply"],
    ]);
    h.emit([child]);
    await h.unread.ensure();
    const started = deferredSidebar<void>();
    const held =
      deferredSidebar<Awaited<ReturnType<typeof h.bff.api.contexts>>>();
    h.bff.api.contexts.mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
    const selected = {
      kind: "message",
      channelId: channel,
      messageId: child.id,
    } as const;
    const stop = h.unread.subscribe(selected, () => {});
    await started.promise;
    try {
      if (action === "unsubscribe") stop();
      else h.grant(channel, [], 20);
    } finally {
      held.resolve({
        account: { retention_seconds: 2592000, cutoff_ms: 0 },
        contexts: [
          {
            status: "available",
            through_timestamp: null,
            messages: [
              {
                message_id: child.id,
                status: "unread",
                reason: "conversation",
              },
            ],
          },
        ],
      });
    }
    const count = h.bff.api.contexts.mock.calls.length;
    await h.unread.refresh();
    expect(h.bff.api.contexts.mock.calls).toHaveLength(count);
    expect(h.unread.attention(channel, child.id).status).toBe("unknown");
    stop();
  },
);
it("retargets shared demand at the lease bound and rejects overflow atomically", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 10);
  const parent = message(h.peer, channel, "parent", 11, [
    ["e", root.id, "", "reply"],
  ]);
  const child = message(h.peer, channel, "child", 12, [
    ["e", parent.id, "", "reply"],
  ]);
  h.emit([child]);
  const selected = {
    kind: "message",
    channelId: channel,
    messageId: child.id,
  } as const;
  const stops = Array.from({ length: 1000 }, () =>
    h.unread.subscribe(selected, () => {}),
  );
  expect(() => h.unread.subscribe(selected, () => {})).toThrow("capacity");
  await h.unread.refresh();
  h.bff.api.contexts.mockClear();
  h.emit([parent, root]);
  await h.unread.refresh();
  expect(h.bff.api.contexts).toHaveBeenCalled();
  for (const [queries] of h.bff.api.contexts.mock.calls)
    expect(queries).toEqual([
      {
        target: { channel_id: channel, root_id: root.id },
        message_ids: [child.id],
      },
    ]);
  for (const stop of stops) stop();
  h.bff.api.contexts.mockClear();
  await h.unread.refresh();
  expect(h.bff.api.contexts).not.toHaveBeenCalled();
  const stop = h.unread.subscribe(selected, () => {});
  await h.unread.refresh();
  expect(h.bff.api.contexts).toHaveBeenCalled();
  stop();
});
it("uses fixed observed message IDs for dwell prefixes and never clears manual unread", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 10),
    reply = message(h.peer, channel, "reply", 11, [
      ["e", root.id, "", "reply"],
    ]);
  h.emit([root, reply]);
  await h.unread.markUnreadLocal(target);
  const reading = h.unread.reading(channel);
  await reading.observe([root.id, reply.id]);
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(h.bff.api.write.mock.calls.flatMap(([intents]) => intents)).toEqual([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: root.id,
    },
    {
      type: "mark_through",
      target: { channel_id: channel, root_id: root.id },
      message_id: reply.id,
    },
  ]);
  expect(h.snapshot().manual).toBe("local-only");
  reading.dispose();
});
it.each(["dispose", "revoke", "manual", "clear"])(
  "fences reading leases after %s",
  async (cause) => {
    const h = setup(),
      row = message(keypair(), channel, "read", 11);
    h.emit([row]);
    const reading = h.unread.reading(channel);
    if (cause === "dispose") reading.dispose();
    if (cause === "revoke") {
      h.grant(channel, [], 20);
      h.grant(channel, [h.viewer.pubkey], 21);
    }
    if (cause === "manual") await h.unread.markUnreadLocal(target);
    if (cause === "clear") await h.clearCache();
    await reading.observe([row.id]);
    expect(h.bff.journal().pending).toEqual([]);
    expect(h.bff.api.write).not.toHaveBeenCalled();
  },
);
it("whole-channel action uses the BFF anchor and clears only that channel's local marks", async () => {
  const h = setup();
  h.grant(other);
  const anchor = "a".repeat(64);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { latest_message_id: anchor, latest_message_at: 42 }),
  );
  await h.unread.ensure();
  await h.unread.markUnreadLocal(target);
  await h.unread.markUnreadLocal({
    kind: "thread",
    channelId: channel,
    rootId: "b".repeat(64),
  });
  await h.unread.markUnreadLocal({ kind: "channel", channelId: other });
  await h.unread.markChannelRead(channel);
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(h.bff.api.write.mock.calls[0]?.[0]).toEqual([
    { type: "mark_channel_read", channel_id: channel, message_id: anchor },
  ]);
  expect(h.bff.journal().manual).toEqual([
    { kind: "channel", channelId: other },
  ]);
});
it("refuses an unknown latest cut, but a proven empty channel can clear local intent", async () => {
  const h = setup();
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { latest_message_complete: false }),
  );
  await h.unread.ensure();
  await h.unread.markUnreadLocal(target);
  await expect(h.unread.markChannelRead(channel)).rejects.toThrow(
    "Latest message unknown",
  );
  expect(h.snapshot().manual).toBe("local-only");
  h.bff.rows.set(channel, sidebarRow(channel));
  await h.unread.refresh();
  await h.unread.markChannelRead(channel);
  expect(h.snapshot().manual).toBe("none");
  expect(h.bff.api.write).not.toHaveBeenCalled();
});
it("denies projections before revocation subscribers and retains durable intent", async () => {
  const h = setup();
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { unread: { status: "exact", value: 1 } }),
  );
  await h.unread.ensure();
  await h.unread.markUnreadLocal(target);
  const seen: unknown[] = [];
  h.unread.subscribe(target, () => seen.push(h.snapshot()));
  h.grant(channel, [], 20);
  expect(seen.length).toBeGreaterThan(0);
  for (const snapshot of seen)
    expect(snapshot).toMatchObject({
      unread: { status: "unknown" },
      manual: "none",
    });
  expect(h.bff.journal().manual).toEqual([target]);
});
it("hydrates only listed previews and does not turn an incomplete list into zero", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 10),
    reply = message(h.peer, channel, "preview", 11, [
      ["e", "a".repeat(64), "", "reply"],
    ]);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, {
      threads: {
        complete: false,
        items: [
          {
            root_id: root.id,
            latest_reply_id: reply.id,
            latest_reply_at: 11,
            unread: { status: "at_least", value: 2 },
          },
        ],
      },
    }),
  );
  await h.unread.ensure();
  expect(
    h.unread.snapshot({
      kind: "thread",
      channelId: channel,
      rootId: "f".repeat(64),
    }).unread,
  ).toEqual({ status: "unknown" });
  h.query.mockResolvedValueOnce([reply]);
  await h.unread.loadActivity(channel);
  expect(h.unread.activity(channel)).toMatchObject({
    complete: false,
    items: [{ preview: "preview", unread: { status: "at_least", value: 2 } }],
  });
  expect(h.bff.api.write).not.toHaveBeenCalled();
});
it.each([true, false])(
  "filters only proven-zero unread from Activity; keeps completeness %s and hydrates selected previews",
  async (complete) => {
    const h = setup();
    const attention = [
      { status: "exact", value: 0 },
      { status: "exact", value: 1 },
      { status: "at_least", value: 1 },
      { status: "unknown" },
    ] as const;
    const items = attention.map((count, i) => ({
      root_id: String(i + 1).repeat(64),
      latest_reply_id: String(i + 5).repeat(64),
      latest_reply_at: 20 - i,
      unread: count,
    }));
    h.bff.rows.set(
      channel,
      sidebarRow(channel, { threads: { complete, items } }),
    );
    await h.unread.ensure();
    expect(h.unread.activity(channel)).toMatchObject({
      complete,
      items: items.slice(1).map((item) => ({
        rootId: item.root_id,
        latestMessageId: item.latest_reply_id,
      })),
    });
    h.query.mockClear();
    await h.unread.loadActivity(channel);
    expect(h.query).toHaveBeenCalledExactlyOnceWith(
      [
        { ids: items.slice(1).map((item) => item.latest_reply_id), limit: 5 },
        {
          kinds: [40003],
          "#e": items.slice(1).map((item) => item.latest_reply_id),
          limit: 500,
        },
      ],
      expect.any(AbortSignal),
      expect.any(String),
      "background",
    );
    expect(h.bff.api.write).not.toHaveBeenCalled();
  },
);

it("live timeline preview updates target only that channel, not the whole sidebar", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.bff.rows.set(channel, sidebarRow(channel));
  await h.unread.ensure();
  await vi.advanceTimersByTimeAsync(1000);
  h.bff.api.sidebar.mockClear();
  h.emit([message(h.peer, channel, "live preview", 15)]);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.bff.api.sidebar.mock.calls.map(([q]) => q)).toEqual([
    { channel_ids: [channel] },
  ]);
  h.bff.api.sidebar.mockClear();
  h.grant(other);
  await vi.advanceTimersByTimeAsync(250);
  expect(
    h.bff.api.sidebar.mock.calls.some(([q]) => !("channel_ids" in q)),
  ).toBe(true);
});

it.each([5, 9005] as const)(
  "a live kind %s deletion rereads only its channel and clears the count",
  async (kind) => {
    vi.useFakeTimers();
    const h = setup();
    const only = message(h.peer, channel, "only unread", 11);
    h.emit([only]);
    h.bff.rows.set(
      channel,
      sidebarRow(channel, {
        unread: { status: "exact", value: 1 },
        latest_message_id: only.id,
        latest_message_at: 11,
      }),
    );
    await h.unread.ensure();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.snapshot().unread).toEqual({ status: "exact", value: 1 });
    h.bff.api.sidebar.mockClear();
    // The relay no longer counts the deleted row; only a reread can show it.
    h.bff.rows.set(channel, sidebarRow(channel));
    h.emit([
      signed(kind === 5 ? h.peer : h.relay, {
        kind,
        content: "",
        created_at: 12,
        tags: [
          ["h", channel],
          ["e", only.id],
        ],
      }),
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.bff.api.sidebar.mock.calls.map(([q]) => q)).toEqual([
      { channel_ids: [channel] },
    ]);
    expect(h.snapshot().unread).toEqual({ status: "exact", value: 0 });
  },
);

it.each(["ensure", "refresh"] as const)(
  "replays a roster change during an older %s traversal",
  async (origin) => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.bff.rows.set(channel, sidebarRow(channel));
    if (origin === "refresh") {
      await h.unread.ensure();
      h.bff.api.sidebar.mockClear();
    }
    h.bff.api.sidebar.mockImplementationOnce(async () => {
      await gate;
      return {
        account: {
          retention_seconds: 2592000,
          cutoff_ms: 0,
        },
        channels: [sidebarRow(channel)],
        next_cursor: null,
      };
    });
    const ready = h.unread[origin]();
    await vi.waitFor(() => expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1));
    h.bff.rows.set(
      other,
      sidebarRow(other, { unread: { status: "exact", value: 12 } }),
    );
    h.grant(other);
    release();
    await ready;
    expect(
      h.unread.snapshot({ kind: "channel", channelId: other }).unread,
    ).toEqual({ status: "exact", value: 12 });
    expect(
      h.bff.api.sidebar.mock.calls.filter(([q]) => !("channel_ids" in q)),
    ).toHaveLength(2);
  },
);

it("repeated ensure waits for the roster before querying or reconciling", async () => {
  const h = setup(false);
  await Promise.all([h.unread.ensure(), h.unread.ensure(), h.unread.ensure()]);
  expect(h.bff.api.sidebar).not.toHaveBeenCalled();
  expect(h.unread.sync().status).toBe("loading");
  h.bff.rows.set(channel, sidebarRow(channel));
  h.grant();
  await h.unread.ensure();
  expect(h.snapshot().unread.status).toBe("exact");
});

it("metadata arriving during a held traversal does not replay access-unchanged rows", async () => {
  const h = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.bff.rows.set(channel, sidebarRow(channel));
  h.bff.api.sidebar.mockImplementationOnce(async () => {
    await gate;
    return {
      account: {
        retention_seconds: 2592000,
        cutoff_ms: 0,
      },
      channels: [sidebarRow(channel)],
      next_cursor: null,
    };
  });
  const initial = h.unread.ensure();
  await vi.waitFor(() => expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1));
  h.emit([metadata(h.relay, channel, "Renamed", 20)]);
  release();
  await initial;
  expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1);
  expect(h.snapshot().unread.status).toBe("exact");
});

it("a row prefix retains its fixed context/anchor without capturing descendants", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 11);
  const child = message(h.peer, channel, "child", 12, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, child]);
  await h.unread.markUnreadLocal(target);
  await h.unread.markThrough(
    { kind: "message", channelId: channel, messageId: root.id },
    root.id,
  );
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(h.bff.api.write.mock.calls.flatMap(([intents]) => intents)).toEqual([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: root.id,
    },
  ]);
  expect(h.snapshot().manual).toBe("local-only");
});
it("a selected local unread mark does not force its reply subtree", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 11);
  const child = message(h.peer, channel, "child", 12, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, child]);
  const selected = {
    kind: "message",
    channelId: channel,
    messageId: root.id,
  } as const;
  await h.unread.markUnreadLocal(selected);
  expect(h.unread.attention(channel, root.id).forced).toBe(true);
  expect(h.unread.attention(channel, child.id).forced).toBe(false);
  expect(h.bff.api.write).not.toHaveBeenCalled();
});

it("a covered observed thread anchor does not mask an incomplete lower-bound tail", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 10);
  const reply = message(h.peer, channel, "observed reply", 20, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply]);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, {
      unread: { status: "at_least", value: 2 },
      attention: { status: "at_least", value: 2 },
      latest_message_id: reply.id,
      latest_message_at: 20,
      threads: {
        complete: false,
        items: [
          {
            root_id: root.id,
            unread: { status: "at_least", value: 2 },
            latest_reply_id: reply.id,
            latest_reply_at: 20,
          },
        ],
      },
    }),
  );
  await h.unread.ensure();
  h.bff.api.write.mockImplementation(() => new Promise(() => {}));
  const thread = {
    kind: "thread",
    channelId: channel,
    rootId: root.id,
  } as const;
  await h.unread.markThrough(thread, reply.id);
  expect(h.unread.snapshot(thread)).toMatchObject({
    unreadVisible: true,
    attentionVisible: true,
  });
  expect(h.unread.activity(channel).items).toHaveLength(1);
});

it("community sweep skips quiet channels, clears manual-only channels and continues past a failed save", async () => {
  const h = setup();
  h.grant(other);
  const quiet = "21234567-89ab-cdef-0123-456789abcdef";
  h.grant(quiet);
  for (const id of [channel, other, quiet]) h.bff.rows.set(id, sidebarRow(id));
  await h.unread.ensure();
  await h.unread.markUnreadLocal(target);
  await h.unread.markUnreadLocal({ kind: "channel", channelId: other });
  const order = h.session.channels
    .list()
    .channels.map((c) => c.id)
    .filter((id) => id !== quiet);
  const first = order[0],
    second = order[1];
  if (!first || !second) throw new Error("Missing sweep channels");
  const update = vi.spyOn(h.bff.storage, "update");
  update.mockRejectedValueOnce(new Error("disk full"));
  await expect(h.unread.markAllChannelsRead()).rejects.toThrow("disk full");
  expect(h.bff.journal().manual).toEqual([
    { kind: "channel", channelId: first },
  ]);
  expect(h.unread.snapshot({ kind: "channel", channelId: second }).manual).toBe(
    "none",
  );
  expect(await h.unread.markAllChannelsRead()).toHaveLength(1);
  update.mockClear();
  expect(await h.unread.markAllChannelsRead()).toEqual([]);
  expect(update).not.toHaveBeenCalled();
  expect(h.bff.api.write).not.toHaveBeenCalled();
});

it("community sweep skips grants revoked while its first save is committing", async () => {
  const h = setup();
  h.grant(other);
  for (const id of [channel, other]) h.bff.rows.set(id, sidebarRow(id));
  await h.unread.ensure();
  for (const id of [channel, other])
    await h.unread.markUnreadLocal({ kind: "channel", channelId: id });
  const [first, second] = h.session.channels.list().channels.map((c) => c.id);
  if (!first || !second) throw new Error("Missing sweep channels");
  const held = deferredSidebar<void>(),
    started = deferredSidebar<void>();
  const update = h.bff.storage.update;
  vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (change) => {
    const result = await update(change);
    started.resolve();
    await held.promise;
    return result;
  });
  const sweep = h.unread.markAllChannelsRead();
  try {
    await started.promise;
    expect(h.bff.journal().manual).toEqual([
      { kind: "channel", channelId: second },
    ]);
    h.grant(second, [], 20);
  } finally {
    held.resolve();
  }
  expect(await sweep).toHaveLength(1);
  expect(h.bff.journal().manual).toEqual([
    { kind: "channel", channelId: second },
  ]);
});

// Any access loss in the community cancels every unsaved channel, not only the
// revoked one; the sweep rejects and can be repeated. A grant cancels nothing.
it.each(["grant", "revoke"] as const)(
  "community sweep after an unrelated %s during its first save",
  async (access) => {
    const h = setup();
    h.grant(other);
    const third = "21234567-89ab-cdef-0123-456789abcdef";
    h.grant(third);
    const [first, second, last] = h.session.channels
      .list()
      .channels.map((c) => c.id);
    if (!first || !second || !last) throw new Error("Missing sweep channels");
    for (const id of [first, second, last]) h.bff.rows.set(id, sidebarRow(id));
    await h.unread.ensure();
    for (const id of [first, second, last])
      await h.unread.markUnreadLocal({ kind: "channel", channelId: id });
    const held = deferredSidebar<void>(),
      started = deferredSidebar<void>();
    const update = h.bff.storage.update;
    vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (change) => {
      const result = await update(change);
      started.resolve();
      await held.promise;
      return result;
    });
    const sweep = h.unread.markAllChannelsRead();
    const later = "31234567-89ab-cdef-0123-456789abcdef";
    try {
      await started.promise;
      if (access === "grant") h.grant(later);
      else h.grant(second, [], 20);
    } finally {
      held.resolve();
    }
    if (access === "grant") {
      expect(h.session.channels.list().channels.map((c) => c.id)).toContain(
        later,
      );
      expect(await sweep).toHaveLength(3);
      expect(h.bff.journal().manual).toEqual([]);
      return;
    }
    await expect(sweep).rejects.toThrow("Reading context changed");
    expect(h.bff.journal().manual).toEqual([
      { kind: "channel", channelId: second },
      { kind: "channel", channelId: last },
    ]);
    expect(await h.unread.markAllChannelsRead()).toHaveLength(1);
    expect(h.bff.journal().manual).toEqual([
      { kind: "channel", channelId: second },
    ]);
  },
);

it("community sweep captures every channel cut before the first journal save", async () => {
  const h = setup();
  h.grant(other);
  const [first, second] = h.session.channels.list().channels.map((c) => c.id);
  if (!first || !second) throw new Error("Missing sweep channels");
  for (const [id, anchor] of [
    [first, "a"],
    [second, "b"],
  ] as const)
    h.bff.rows.set(
      id,
      sidebarRow(id, {
        unread: { status: "exact", value: 1 },
        latest_message_id: anchor.repeat(64),
        latest_message_at: 20,
      }),
    );
  await h.unread.ensure();
  const started = deferredSidebar<void>(),
    held = deferredSidebar<void>();
  const update = h.bff.storage.update;
  vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (change) => {
    started.resolve();
    await held.promise;
    return update(change);
  });
  const sweep = h.unread.markAllChannelsRead();
  try {
    await started.promise;
    h.bff.rows.set(
      second,
      sidebarRow(second, {
        unread: { status: "exact", value: 2 },
        latest_message_id: "c".repeat(64),
        latest_message_at: 30,
      }),
    );
    await h.unread.refresh();
    expect(
      h.unread.snapshot({ kind: "channel", channelId: second }).latestMessage
        ?.id,
    ).toBe("c".repeat(64));
  } finally {
    held.resolve();
  }
  await sweep;
  await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
  expect(
    h.bff.api.write.mock.calls.flatMap(([intents]) => intents),
  ).toContainEqual({
    type: "mark_channel_read",
    channel_id: second,
    message_id: "b".repeat(64),
  });
});
it.each([false, true])(
  "community sweep preserves a newer manual choice behind the first save (empty=%s)",
  async (empty) => {
    const h = setup();
    h.grant(other);
    const [first, second] = h.session.channels.list().channels.map((c) => c.id);
    if (!first || !second) throw new Error("Missing sweep channels");
    for (const id of [first, second])
      h.bff.rows.set(
        id,
        sidebarRow(
          id,
          empty
            ? {}
            : {
                unread: { status: "exact", value: 1 },
                latest_message_id: "a".repeat(64),
                latest_message_at: 20,
              },
        ),
      );
    await h.unread.ensure();
    for (const id of [first, second])
      await h.unread.markUnreadLocal({ kind: "channel", channelId: id });
    const started = deferredSidebar<void>(),
      held = deferredSidebar<void>();
    const update = h.bff.storage.update;
    vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (change) => {
      started.resolve();
      await held.promise;
      return update(change);
    });
    const sweep = h.unread.markAllChannelsRead();
    let mark: ReturnType<typeof h.unread.markUnreadLocal> | undefined;
    try {
      await started.promise;
      mark = h.unread.markUnreadLocal({ kind: "channel", channelId: second });
      expect(
        h.unread.snapshot({ kind: "channel", channelId: second }).manual,
      ).toBe("local-only");
    } finally {
      held.resolve();
    }
    await Promise.all([sweep, mark]);
    expect(h.bff.journal().manual).toEqual([
      { kind: "channel", channelId: second },
    ]);
    expect(
      h.unread.snapshot({ kind: "channel", channelId: second }).manual,
    ).toBe("local-only");
  },
);
it.each(["revoke-regrant", "clear", "dispose"])(
  "community sweep cannot revive reserved cuts after %s",
  async (action) => {
    const h = setup();
    h.grant(other);
    for (const id of [channel, other])
      h.bff.rows.set(
        id,
        sidebarRow(id, {
          unread: { status: "exact", value: 1 },
          latest_message_id: "a".repeat(64),
          latest_message_at: 20,
        }),
      );
    await h.unread.ensure();
    const started = deferredSidebar<void>(),
      held = deferredSidebar<void>();
    const update = h.bff.storage.update;
    vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (change) => {
      started.resolve();
      await held.promise;
      return update(change);
    });
    const sweep = h.unread.markAllChannelsRead();
    const finished = sweep.catch(() => {});
    try {
      await started.promise;
      if (action === "revoke-regrant") {
        h.grant(other, [], 20);
        h.grant(other, [h.viewer.pubkey], 21);
      } else if (action === "clear") await h.clearCache();
      else h.dispose();
    } finally {
      held.resolve();
    }
    await finished;
    expect(h.bff.journal().pending).toEqual([]);
    expect(h.bff.api.write).not.toHaveBeenCalled();
  },
);
it("community sweep excludes later grants and continues past an incomplete selected cut", async () => {
  const h = setup();
  h.grant(other);
  const third = "21234567-89ab-cdef-0123-456789abcdef";
  h.grant(third);
  const [first, second, last] = h.session.channels
    .list()
    .channels.map((c) => c.id);
  if (!first || !second || !last) throw new Error("Missing sweep channels");
  for (const id of [first, second, last])
    h.bff.rows.set(
      id,
      sidebarRow(id, {
        unread: { status: "exact", value: 1 },
        latest_message_id: id === second ? null : "a".repeat(64),
        latest_message_at: id === second ? null : 20,
        latest_message_complete: id !== second,
      }),
    );
  await h.unread.ensure();
  const started = deferredSidebar<void>(),
    held = deferredSidebar<void>();
  const update = h.bff.storage.update;
  vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (change) => {
    started.resolve();
    await held.promise;
    return update(change);
  });
  const sweep = h.unread.markAllChannelsRead();
  const rejected = expect(sweep).rejects.toThrow("Latest message unknown");
  const later = "31234567-89ab-cdef-0123-456789abcdef";
  try {
    await started.promise;
    h.bff.rows.set(
      later,
      sidebarRow(later, {
        unread: { status: "exact", value: 1 },
        latest_message_id: "b".repeat(64),
        latest_message_at: 30,
      }),
    );
    h.grant(later);
  } finally {
    held.resolve();
  }
  await rejected;
  await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
  expect(h.bff.api.write.mock.calls.flatMap(([intents]) => intents)).toEqual([
    {
      type: "mark_channel_read",
      channel_id: first,
      message_id: "a".repeat(64),
    },
    { type: "mark_channel_read", channel_id: last, message_id: "a".repeat(64) },
  ]);
});
it("community sweep sends fixed cuts only for relay unread evidence and leaves unknown quiet", async () => {
  const h = setup();
  h.grant(other);
  const anchor = "a".repeat(64);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, {
      unread: { status: "at_least", value: 2 },
      latest_message_id: anchor,
      latest_message_at: 25,
    }),
  );
  h.bff.rows.set(other, sidebarRow(other, { unread: { status: "unknown" } }));
  await h.unread.ensure();
  expect(await h.unread.markAllChannelsRead()).toHaveLength(1);
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalledOnce());
  expect(h.bff.api.write.mock.calls[0]?.[0]).toEqual([
    { type: "mark_channel_read", channel_id: channel, message_id: anchor },
  ]);
});

it.each([
  { kind: "message", held: false },
  { kind: "thread", held: false },
  { kind: "message", held: true },
  { kind: "thread", held: true },
] as const)(
  "community sweep includes exact-zero channels with only a local target: %j",
  async ({ kind, held }) => {
    const h = setup();
    const root = message(h.peer, channel, "root", 11);
    h.emit([root]);
    h.bff.rows.set(channel, sidebarRow(channel));
    await h.unread.ensure();
    const selected =
      kind === "message"
        ? { kind, channelId: channel, messageId: root.id }
        : { kind, channelId: channel, rootId: root.id };
    const gate = deferredSidebar<void>(),
      started = deferredSidebar<void>();
    if (held) {
      const update = h.bff.storage.update;
      vi.spyOn(h.bff.storage, "update").mockImplementationOnce(
        async (change) => {
          started.resolve();
          await gate.promise;
          return update(change);
        },
      );
    }
    const mark = h.unread.markUnreadLocal(selected);
    let sweep: ReturnType<typeof h.unread.markAllChannelsRead> | undefined;
    try {
      if (held) await started.promise;
      else await mark;
      expect(h.snapshot()).toMatchObject({
        unread: { status: "exact", value: 0 },
        manual: "none",
      });
      expect(h.unread.snapshot(selected).manual).toBe("local-only");
      if (kind === "message")
        expect(h.unread.attention(channel, root.id).forced).toBe(true);
      sweep = h.unread.markAllChannelsRead();
      // Selection must see transient marks, without waiting for the older save.
      expect(h.unread.snapshot(selected).manual).toBe("none");
      gate.resolve();
      await mark;
      expect(await sweep).toHaveLength(1);
      expect(h.bff.journal().manual).toEqual([]);
      expect(h.unread.snapshot(selected).manual).toBe("none");
      if (kind === "message")
        expect(h.unread.attention(channel, root.id).forced).toBe(false);
      expect(h.bff.api.write).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await Promise.allSettled([mark, sweep]);
    }
  },
);
it.each(["cross-channel", "missing", "valid (control)"] as const)(
  "markUnreadLocal rejects a %s message target before saving it (RED at 927f431)",
  async (shape) => {
    const h = setup();
    h.grant(other);
    const elsewhere = message(h.peer, other, "elsewhere", 11),
      here = message(h.peer, channel, "here", 12);
    h.emit([elsewhere, here]);
    await h.unread.ensure();
    const messageId =
      shape === "cross-channel"
        ? elsewhere.id
        : shape === "missing"
          ? "c".repeat(64)
          : here.id;
    const marking = h.unread.markUnreadLocal({
      kind: "message",
      channelId: channel,
      messageId,
    });
    if (shape === "valid (control)") {
      await marking;
      expect(h.bff.journal().manual).toEqual([
        { kind: "message", channelId: channel, messageId },
      ]);
    } else {
      await expect(marking).rejects.toThrow();
      expect(h.bff.journal().manual).toEqual([]);
    }
  },
);
it.each([
  "stays a member (control)",
  "leaves a public channel",
  "leaves a private channel",
] as const)(
  "a reading save in flight is not sent when the viewer %s",
  async (change) => {
    const h = setup(false);
    const visibility =
      change === "leaves a private channel" ? [] : [["public"]];
    h.emit([
      roster(h.relay, channel, [h.viewer.pubkey], 10),
      metadata(h.relay, channel, "Room", 10, visibility),
    ]);
    h.bff.rows.set(channel, sidebarRow(channel));
    h.grant(other);
    const anchor = "a".repeat(64);
    h.bff.rows.set(
      other,
      sidebarRow(other, { latest_message_id: anchor, latest_message_at: 42 }),
    );
    await h.unread.ensure();
    const row = message(h.peer, channel, "hello", 11);
    h.emit([row]);
    const handle = h.unread.reading(channel);
    const update = h.bff.storage.update;
    let started!: () => void, release!: () => void;
    const saving = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (next) => {
      started();
      await gate;
      return update(next);
    });
    const observing = handle.observe([row.id]);
    await saving;
    if (change !== "stays a member (control)")
      h.emit([roster(h.relay, channel, [h.peer.pubkey], 20)]);
    release();
    if (change === "stays a member (control)") {
      await observing;
      await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalledOnce());
      return;
    }
    await expect(observing).rejects.toThrow("Reading context changed");
    // Flush sends only journal intents: none were saved, so none can be sent.
    expect(h.bff.journal().pending).toEqual([]);
    // Barrier: a later flush sends every pending intent, so one that carries
    // only the other channel's read proves this save never became sendable.
    await h.unread.markChannelRead(other);
    await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalledOnce());
    expect(h.bff.api.write.mock.calls[0]?.[0]).toEqual([
      { type: "mark_channel_read", channel_id: other, message_id: anchor },
    ]);
    await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
  },
);
it.each(
  (
    [
      ["an unedited reply", 9, "plain", "plain", "plain"],
      ["an edited reply", 9, "original", "original", "edited"],
      [
        "an agent reply",
        40002,
        JSON.stringify({ content: "agent says" }),
        "agent says",
        "agent says",
      ],
      ["a reply the fold does not present", 45003, "raw", "raw", "raw"],
    ] as const
  ).flatMap(
    ([name, ...arm]) =>
      [
        [name, "observed live", ...arm],
        [name, "unobserved", ...arm],
      ] as const,
  ),
)(
  "Activity previews %s, %s, as the timeline presents it",
  async (_, observed, kind, content, unloaded, presented) => {
    const live = observed === "observed live";
    const h = setup();
    const root = message(h.peer, channel, "root", 10);
    const reply = signed(h.peer, {
      kind,
      content,
      created_at: 11,
      tags: [
        ["h", channel],
        ["e", root.id, "", "root"],
      ],
    });
    const edit = (key: typeof h.peer, text: string, created_at: number) =>
      signed(key, {
        kind: 40003,
        content: text,
        created_at,
        tags: [
          ["h", channel],
          ["e", reply.id],
        ],
      });
    if (live) h.emit([root, reply]);
    h.bff.rows.set(
      channel,
      sidebarRow(channel, {
        threads: {
          complete: true,
          items: [
            {
              root_id: root.id,
              latest_reply_id: reply.id,
              latest_reply_at: 11,
              unread: { status: "exact", value: 1 },
            },
          ],
        },
      }),
    );
    await h.unread.ensure();
    const preview = () => h.unread.activity(channel).items?.[0]?.preview;
    expect(preview()).toBe(live ? unloaded : "Open thread to read");
    // The relay answers only what the read asks for.
    const open = (stored: readonly RelayEvent[]) => {
      h.query.mockImplementationOnce(async (filters) =>
        stored.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      );
      return h.unread.loadActivity(channel);
    };
    await open(
      presented === "edited"
        ? [
            // Newest, but not the author's: never the presentation.
            edit(h.viewer, "forged", 14),
            edit(h.peer, "edited", 13),
            edit(h.peer, "superseded", 12),
            reply,
          ]
        : [reply],
    );
    expect(preview()).toBe(presented);
    // The relay stops returning a deleted edit, so the next open drops it.
    await open([reply]);
    expect(preview()).toBe(unloaded);
  },
);

function cachedRoster(viewer: string, cached: boolean, ids = [channel]) {
  const listeners = new Set<() => void>();
  let list = { status: "ready", channels: [] as unknown[] };
  const set = (next: boolean, next_ids = ids) => {
    list = {
      status: "ready",
      channels: next_ids.map((id) => ({ id, cached: next, members: [viewer] })),
    };
    for (const listener of listeners) listener();
  };
  set(cached);
  const channels = {
    list: () => list,
    subscribeList(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Parameters<typeof createUnread>[0]["channels"];
  return { channels, set };
}

it.each([
  ["confirmation", true],
  ["fresh empty roster", false],
] as const)(
  "a cached restore starts no walk; a %s starts exactly one",
  async (_label, restored) => {
    vi.useFakeTimers();
    const bff = sidebarFixture(),
      viewer = keypair();
    bff.rows.set(
      channel,
      sidebarRow(channel, { unread: { status: "exact", value: 3 } }),
    );
    const roster = cachedRoster(viewer.pubkey, true);
    const owner = createUnread({
      api: bff.api,
      storage: bff.storage,
      scope: "cached-restore",
      channels: roster.channels,
      viewer: viewer.pubkey,
      reader: { read: async () => [] },
      find: () => undefined,
    });
    cleanups.push(owner.dispose);
    const walks = () =>
      bff.api.sidebar.mock.calls.filter(([q]) => !("channel_ids" in q)).length;
    await owner.capability.ensure();
    // A restore that changes while still unconfirmed is no reason to walk.
    roster.set(true, [channel, other]);
    // Completion barrier: run the timers that change left pending, with their
    // microtasks.
    await vi.runOnlyPendingTimersAsync();
    // Offline after a restore: no walk, and nothing claims to be observed.
    expect(walks()).toBe(0);
    expect(owner.capability.sync().status).toBe("loading");
    expect(owner.capability.snapshot(target)).toMatchObject({
      unread: { status: "unknown" },
      freshness: "unknown",
    });
    if (restored) roster.set(false);
    else roster.set(false, []);
    await vi.waitFor(() =>
      expect(owner.capability.sync().status).toBe("reconciled"),
    );
    expect(walks()).toBe(1);
    expect(owner.capability.snapshot(target).unread).toEqual(
      restored ? { status: "exact", value: 3 } : { status: "unknown" },
    );
  },
);

it("does not speculate unread for unclassified plain live replies", async () => {
  const h = setup();
  h.bff.rows.set(channel, sidebarRow(channel));
  await h.unread.ensure();
  const root = message(h.peer, channel, "parent", 10);
  h.emit([root]);
  const reply = message(
    h.peer,
    channel,
    "unjoined reply",
    Math.floor(Date.now() / 1000),
    [["e", root.id, "", "reply"]],
  );
  h.emit([reply], "live");
  expect(h.snapshot().unreadVisible).toBe(false);
  expect(
    h.unread.snapshot({ kind: "thread", channelId: channel, rootId: root.id })
      .unreadVisible,
  ).toBe(false);
  h.bff.messages.set(reply.id, { message_id: reply.id, status: "not_counted" });
  const stop = h.unread.subscribe(
    { kind: "message", channelId: channel, messageId: reply.id },
    () => {},
  );
  cleanups.push(stop);
  await h.unread.refresh();
  expect(h.snapshot().unreadVisible).toBe(false);
  expect(h.unread.attention(channel, reply.id)).toMatchObject({
    status: "ineligible",
    unread: false,
  });
});

it.each([
  { reason: "direct", category: "direct", attention: 1 },
  { reason: "mention", category: "mention", attention: 1 },
  { reason: "conversation", category: "thread", attention: 1 },
  { reason: "broadcast", category: undefined, attention: 1 },
  { reason: null, category: undefined, attention: 0 },
] as const)(
  "uses relay reason $reason rather than local tags or root ownership",
  async ({ reason, category, attention }) => {
    const h = setup();
    const reply = message(h.peer, channel, "tagged reply", 12, [
      ["e", "a".repeat(64), "", "reply"],
      ["p", h.viewer.pubkey],
      ["broadcast", "1"],
    ]);
    h.emit([reply]);
    h.bff.messages.set(reply.id, {
      message_id: reply.id,
      status: "unread",
      reason,
    });
    const selected = {
      kind: "message",
      channelId: channel,
      messageId: reply.id,
    } as const;
    cleanups.push(h.unread.subscribe(selected, () => {}));
    await h.unread.refresh();
    expect(h.unread.attention(channel, reply.id).category).toBe(category);
    expect(h.unread.attention(channel, reply.id).mentioned).toBe(true);
    expect(h.unread.snapshot(selected)).toMatchObject({
      unread: { status: "exact", value: 1 },
      attention: { status: "exact", value: attention },
    });
  },
);

// Inbox reads the relay's per-message verdict (Eva 3b4a22d3): a row exists only
// for a verified candidate the relay calls unread with a direct, mention or
// conversation reason. Tests drive only the public session surface.
type Verdict = MessageReadState["status"] | `unread:${string}`;
function verdicts(
  h: ReturnType<typeof setup>,
  entries: readonly (readonly [RelayEvent, Verdict])[],
) {
  for (const [event, verdict] of entries)
    h.bff.messages.set(
      event.id,
      verdict.startsWith("unread:")
        ? ({
            message_id: event.id,
            status: "unread",
            reason: (verdict.slice(7) === "null"
              ? null
              : verdict.slice(7)) as UnreadReason | null,
          } as MessageReadState)
        : ({ message_id: event.id, status: verdict } as MessageReadState),
    );
}
const inboxOpen = new WeakSet<object>();
async function inbox(h: ReturnType<typeof setup>) {
  if (!inboxOpen.has(h.unread)) {
    cleanups.push(h.unread.subscribeInbox(() => {}));
    inboxOpen.add(h.unread);
  }
  await h.unread.refresh();
  await vi.waitFor(() => expect(h.unread.inbox().status).not.toBe("loading"));
  return h.unread.inbox();
}
const settled = (snapshot: InboxSnapshot) =>
  snapshot.status === "ready" && snapshot.freshness === "observed";
const threadOf = (rootId: string) =>
  ({ kind: "thread", channelId: channel, rootId }) as const;
const writes = (h: ReturnType<typeof setup>) =>
  h.bff.api.write.mock.calls.flatMap(([intents]) => intents);

it("inbox: a peer's direct reply beside the viewer's reply is one thread item; own, parent and nested replies do not count", async () => {
  const h = setup();
  const parent = message(h.peer, channel, "parent", 10);
  const mine = message(h.viewer, channel, "my reply", 11, [
    ["e", parent.id, "", "root"],
    ["e", parent.id, "", "reply"],
  ]);
  const sibling = message(h.peer, channel, "sibling reply", 12, [
    ["e", parent.id, "", "root"],
    ["e", parent.id, "", "reply"],
  ]);
  const nested = message(h.peer, channel, "nested reply", 13, [
    ["e", parent.id, "", "root"],
    ["e", sibling.id, "", "reply"],
  ]);
  h.emit([parent, mine, sibling, nested]);
  verdicts(h, [
    [parent, "read"],
    [mine, "not_counted"],
    [sibling, "unread:conversation"],
    [nested, "unread:broadcast"],
  ]);
  const snapshot = await inbox(h);
  expect(settled(snapshot)).toBe(true);
  expect(snapshot.items).toHaveLength(1);
  const [item] = snapshot.items;
  expect(item).toMatchObject({
    channelId: channel,
    target: threadOf(parent.id),
    messageId: sibling.id,
    messageIds: [sibling.id],
    rootId: parent.id,
    thread: true,
    unreadCount: 1,
    manual: false,
    readThrough: [{ target: threadOf(parent.id), messageId: sibling.id }],
  });
});

it("inbox: a manual mark overlays an admitted row; reading it removes the row; a reasonless mark gets no row and stays journaled", async () => {
  const h = setup();
  const parent = message(h.peer, channel, "parent", 10);
  const reply = message(h.peer, channel, "reply", 11, [
    ["e", parent.id, "", "root"],
    ["e", parent.id, "", "reply"],
  ]);
  h.emit([parent, reply]);
  verdicts(h, [
    [parent, "read"],
    [reply, "unread:conversation"],
  ]);
  const item = (await inbox(h)).items[0];
  if (!item) throw new Error("Missing admitted thread row");
  await h.unread.markUnreadLocal(item.target);
  expect((await inbox(h)).items[0]).toMatchObject({
    id: item.id,
    manual: true,
    unreadCount: 1,
  });
  for (const step of item.readThrough)
    await h.unread.markThrough(step.target, step.messageId);
  verdicts(h, [[reply, "read"]]);
  const after = await inbox(h);
  expect(after.items).toEqual([]);
  expect(h.bff.journal().manual).toEqual([]);
  // Manual intent with no remaining relay reason: no Inbox row, never erased.
  await h.unread.markUnreadLocal(item.target);
  expect((await inbox(h)).items).toEqual([]);
  expect(h.bff.journal().manual).toEqual([item.target]);
  expect(h.unread.snapshot(item.target).manual).toBe("local-only");
});

it("inbox: a reply whose root is not loaded is still a thread item from its signed ancestry", async () => {
  const h = setup();
  const root = "c".repeat(64);
  const mine = message(h.viewer, channel, "my reply", 11, [
    ["e", root, "", "root"],
    ["e", root, "", "reply"],
  ]);
  const reply = message(h.peer, channel, "reply to me", 12, [
    ["e", root, "", "root"],
    ["e", mine.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  h.emit([mine, reply]);
  verdicts(h, [
    [mine, "not_counted"],
    [reply, "unread:conversation"],
  ]);
  const snapshot = await inbox(h);
  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.items[0]).toMatchObject({
    target: threadOf(root),
    rootId: root,
    messageId: reply.id,
    thread: true,
    readThrough: [{ target: threadOf(root), messageId: reply.id }],
  });
});

it.each([
  { verdict: "unread:direct", admitted: true },
  { verdict: "unread:mention", admitted: true },
  { verdict: "unread:conversation", admitted: true },
  { verdict: "unread:broadcast", admitted: false },
  { verdict: "unread:null", admitted: false },
  { verdict: "read", admitted: false },
  { verdict: "not_counted", admitted: false },
] as const)(
  "inbox admits a top-level row only for a relay reason: $verdict",
  async ({ verdict, admitted }) => {
    const h = setup();
    const row = message(h.peer, channel, "top level", 12, [
      ["p", h.viewer.pubkey],
    ]);
    h.emit([row]);
    verdicts(h, [[row, verdict]]);
    const snapshot = await inbox(h);
    expect(settled(snapshot)).toBe(true);
    expect(snapshot.items.map((item) => item.messageId)).toEqual(
      admitted ? [row.id] : [],
    );
    // A top-level row has no Inbox read action: never a timeline prefix.
    if (admitted) expect(snapshot.items[0]?.readThrough).toEqual([]);
    expect(h.bff.api.write).not.toHaveBeenCalled();
  },
);

it("inbox groups a direct-message channel into one channel-target row with no prefix steps", async () => {
  const h = setup();
  const dm = other;
  h.grant(dm, [h.viewer.pubkey, h.peer.pubkey]);
  h.emit([metadata(h.relay, dm, "DM", 11, [["t", "dm"]])]);
  const first = message(h.peer, dm, "hello", 20);
  const second = message(h.peer, dm, "again", 21);
  h.emit([first, second]);
  verdicts(h, [
    [first, "unread:direct"],
    [second, "unread:direct"],
  ]);
  const snapshot = await inbox(h);
  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.items[0]).toMatchObject({
    channelId: dm,
    target: { kind: "channel", channelId: dm },
    messageId: first.id,
    latestMessageId: second.id,
    unreadCount: 2,
    readThrough: [],
  });
});

it.each(["unknown", "unavailable", "context-unavailable"] as const)(
  "inbox keeps an %s verdict visibly unresolved, never read or zero",
  async (kind) => {
    const h = setup();
    const row = message(h.peer, channel, "mention", 12, [
      ["p", h.viewer.pubkey],
    ]);
    h.emit([row]);
    if (kind === "context-unavailable")
      h.bff.api.contexts.mockImplementation(async (queries) => ({
        account: sidebarAccount,
        contexts: queries.map(() => ({ status: "unavailable" as const })),
      }));
    else verdicts(h, [[row, kind]]);
    const snapshot = await inbox(h);
    expect(h.bff.api.contexts).toHaveBeenCalled();
    expect(snapshot.items).toEqual([]);
    expect(settled(snapshot)).toBe(false);
    // Positive control: the same candidate settles once the relay answers.
    h.bff.api.contexts.mockImplementation(async (queries) => ({
      account: sidebarAccount,
      contexts: queries.map((q) => ({
        status: "available" as const,
        through_timestamp: null,
        messages: q.message_ids.map((id) => ({
          message_id: id,
          status: "unread" as const,
          reason: "mention" as const,
        })),
      })),
    }));
    const answered = await inbox(h);
    expect(settled(answered)).toBe(true);
    expect(answered.items.map((item) => item.messageId)).toEqual([row.id]);
  },
);

it("inbox thread prefix writes one thread intent and never acknowledges the root or an unrelated mention", async () => {
  const h = setup();
  const root = message(h.peer, channel, "mentioned root", 10, [
    ["p", h.viewer.pubkey],
  ]);
  const reply = message(h.peer, channel, "mentioned reply", 11, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  const unrelated = message(h.peer, channel, "other mention", 12, [
    ["p", h.viewer.pubkey],
  ]);
  h.emit([root, reply, unrelated]);
  verdicts(h, [
    [root, "unread:mention"],
    [reply, "unread:mention"],
    [unrelated, "unread:mention"],
  ]);
  const snapshot = await inbox(h);
  const item = snapshot.items.find((row) => row.messageIds.includes(reply.id));
  if (!item) throw new Error("Missing thread row");
  expect(item.readThrough).toEqual([
    { target: threadOf(root.id), messageId: reply.id },
  ]);
  for (const step of item.readThrough)
    await h.unread.markThrough(step.target, step.messageId);
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(writes(h)).toEqual([
    {
      type: "mark_through",
      target: { channel_id: channel, root_id: root.id },
      message_id: reply.id,
    },
  ]);
  expect(h.unread.attention(channel, root.id).unread).toBe(true);
  expect(h.unread.attention(channel, unrelated.id).unread).toBe(true);
});

it("inbox: a prepared channel read retries its captured anchor and leaves a newer manual mark alone", async () => {
  const h = setup();
  const anchor = "a".repeat(64),
    later = "b".repeat(64);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { latest_message_id: anchor, latest_message_at: 42 }),
  );
  await h.unread.ensure();
  await h.unread.markUnreadLocal(target);
  const read = h.unread.prepareChannelRead(channel);
  const update = vi.spyOn(h.bff.storage, "update");
  update.mockRejectedValueOnce(new Error("disk full"));
  await expect(read()).rejects.toThrow("disk full");
  expect(h.snapshot().manual).toBe("local-only");
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { latest_message_id: later, latest_message_at: 50 }),
  );
  await h.unread.refresh();
  const newer = threadOf("d".repeat(64));
  await h.unread.markUnreadLocal(newer);
  await read();
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(writes(h)).toEqual([
    { type: "mark_channel_read", channel_id: channel, message_id: anchor },
  ]);
  expect(h.snapshot().manual).toBe("none");
  expect(h.bff.journal().manual).toEqual([newer]);
});

it("inbox demand stops at 100 candidates and leaves the 101st visibly unresolved", async () => {
  const h = setup();
  const rows = Array.from({ length: 101 }, (_, i) =>
    message(h.peer, channel, `mention ${i}`, 100 + i, [["p", h.viewer.pubkey]]),
  );
  h.emit(rows);
  verdicts(
    h,
    rows.map((row) => [row, "unread:mention"] as const),
  );
  const snapshot = await inbox(h);
  const demanded = new Set(
    h.bff.api.contexts.mock.calls.flatMap(([queries]) =>
      queries.flatMap((q) => q.message_ids),
    ),
  );
  expect(demanded.size).toBeLessThanOrEqual(100);
  expect(snapshot.items.length).toBeLessThanOrEqual(100);
  expect(settled(snapshot)).toBe(false);
});

it("inbox folds edits and deletions and revokes all evidence before a reentrant subscriber", async () => {
  const h = setup();
  const row = message(h.peer, channel, "original", 20, [
    ["p", h.viewer.pubkey],
  ]);
  h.emit([row]);
  verdicts(h, [[row, "unread:mention"]]);
  expect((await inbox(h)).items[0]?.preview).toBe("original");
  h.emit([
    signed(h.peer, {
      kind: 40003,
      created_at: 21,
      content: "edited",
      tags: [
        ["h", channel],
        ["e", row.id],
      ],
    }),
  ]);
  expect((await inbox(h)).items[0]?.preview).toBe("edited");
  const noticed: number[] = [];
  h.unread.subscribe(target, () => noticed.push(h.unread.inbox().items.length));
  h.emit([roster(h.relay, channel, [], 30)]);
  expect(noticed.at(-1)).toBe(0);
  expect(h.unread.inbox().items).toHaveLength(0);
  h.grant(channel, [h.viewer.pubkey], 31);
  expect(h.unread.inbox().items).toHaveLength(0);
  h.emit([row]);
  h.emit([
    signed(h.peer, {
      kind: 5,
      created_at: 32,
      content: "",
      tags: [["e", row.id]],
    }),
  ]);
  expect((await inbox(h)).items).toHaveLength(0);
  h.dispose();
  expect(h.unread.inbox().items).toHaveLength(0);
});

it("inbox: a reply surviving root deletion keeps its thread row and clears through its prefix", async () => {
  const h = setup();
  const root = message(h.peer, channel, "root", 20);
  const reply = message(h.peer, channel, "surviving mention", 21, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  h.emit([
    root,
    reply,
    signed(h.peer, {
      kind: 5,
      content: "",
      created_at: 22,
      tags: [["e", root.id]],
    }),
  ]);
  verdicts(h, [[reply, "unread:mention"]]);
  const item = (await inbox(h)).items[0];
  if (!item) throw new Error("Missing surviving reply row");
  expect(item).toMatchObject({ rootId: root.id, messageId: reply.id });
  await h.unread.markUnreadLocal(item.target);
  expect((await inbox(h)).items[0]?.manual).toBe(true);
  for (const step of item.readThrough)
    await h.unread.markThrough(step.target, step.messageId);
  expect(h.bff.journal().manual).toEqual([]);
});

it("inbox observation: empty, context failure and cache clear never become a settled zero", async () => {
  const h = setup();
  expect(h.unread.inbox().status).toBe("idle");
  const row = message(h.peer, channel, "fresh", 20, [["p", h.viewer.pubkey]]);
  h.emit([row]);
  verdicts(h, [[row, "unread:mention"]]);
  // Contexts stay offline until the explicit recovery phase. The owner's own
  // retries are not suppressed; they simply cannot succeed before then.
  const answer = h.bff.api.contexts.getMockImplementation();
  if (!answer) throw new Error("Missing contexts fixture");
  let offline = true;
  h.bff.api.contexts.mockImplementation(async (queries, signal) => {
    if (offline) throw new Error("offline");
    return answer(queries, signal);
  });
  const failed = await inbox(h);
  expect(failed).toMatchObject({
    status: "error",
    freshness: "stale",
    items: [],
  });
  offline = false;
  const recovered = await inbox(h);
  expect(settled(recovered)).toBe(true);
  expect(recovered.items).toHaveLength(1);
  await h.clearCache();
  expect(h.unread.inbox().items).toHaveLength(0);
});

// A frozen key (present at prepare) is cleared by any later invocation, even if
// re-marked; a key first marked after prepare survives every invocation.
it("inbox: prepared channel reads serialize with marks made while the first attempt commits", async () => {
  const h = setup();
  const anchor = "a".repeat(64);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { latest_message_id: anchor, latest_message_at: 42 }),
  );
  await h.unread.ensure();
  await h.unread.markUnreadLocal(target);
  const read = h.unread.prepareChannelRead(channel);
  const held = deferredSidebar<void>(),
    started = deferredSidebar<void>();
  const update = h.bff.storage.update;
  vi.spyOn(h.bff.storage, "update").mockImplementationOnce(async (change) => {
    const result = await update(change);
    started.resolve();
    await held.promise;
    return result;
  });
  const first = read();
  const newer = threadOf("d".repeat(64));
  try {
    await started.promise;
    const mark = h.unread.markUnreadLocal(newer);
    const remark = h.unread.markUnreadLocal(target);
    const last = read();
    held.resolve();
    await Promise.all([first, mark, remark, last]);
  } finally {
    held.resolve();
  }
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(
    writes(h).every(
      (intent) =>
        intent.type === "mark_channel_read" && intent.message_id === anchor,
    ),
  ).toBe(true);
  expect(h.snapshot().manual).toBe("none");
  expect(h.bff.journal().manual).toEqual([newer]);
});

it.each(["clearCache", "dispose", "revoke-regrant"] as const)(
  "inbox: a prepared channel read cannot retry past %s",
  async (change) => {
    const h = setup();
    h.bff.rows.set(
      channel,
      sidebarRow(channel, {
        latest_message_id: "a".repeat(64),
        latest_message_at: 42,
      }),
    );
    await h.unread.ensure();
    await h.unread.markUnreadLocal(target);
    const before = structuredClone(h.bff.journal());
    const read = h.unread.prepareChannelRead(channel);
    if (change === "revoke-regrant") {
      h.grant(channel, [], 20);
      h.grant(channel, [h.viewer.pubkey], 21);
    } else await h[change]();
    await expect(read()).rejects.toThrow();
    expect(h.bff.journal()).toEqual(before);
    expect(h.bff.api.write).not.toHaveBeenCalled();
  },
);
