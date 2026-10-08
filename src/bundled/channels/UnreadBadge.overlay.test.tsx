// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { MessageRow } from "../../features/messages/MessageRow";
import { foldMessages } from "../../features/relay/fold";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { UnreadBadge } from "./UnreadBadge";
import { createRelaySession } from "../../features/relay/session";
import {
  sidebarFixture,
  sidebarRow,
  deferredSidebar,
} from "../../features/relay/sidebar-testing";
import {
  keypair,
  message,
  metadata,
  roster,
} from "../../features/relay/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import type {
  IntentOutcome,
  SidebarPage,
} from "../../features/relay/sidebar-api";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

it.each(["applied", "blocked"] as const)(
  "keeps relay badge evidence during saving, failed refresh and a newer %s cut",
  async (outcome) => {
    const bff = sidebarFixture(),
      viewer = keypair(),
      peer = keypair(),
      relay = keypair();
    const first = message(peer, channel, "first", 10),
      second = message(peer, channel, "second", 20);
    const row = sidebarRow(channel, {
      unread: { status: "exact", value: 2 },
      attention: { status: "exact", value: 2 },
      latest_message_id: first.id,
      latest_message_at: 10,
    });
    bff.rows.set(channel, row);
    let persistence: ReturnType<typeof deferredSidebar<void>> | undefined;
    const storage = {
      ...bff.storage,
      async update(change: Parameters<typeof bff.storage.update>[0]) {
        await persistence?.promise;
        return bff.storage.update(change);
      },
    };
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        sidebarApi: bff.api,
        query: async () => [],
        media: () => undefined,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { sidebarStorage: storage },
    );
    owners.push(owner);
    live.receive([
      roster(relay, channel, [viewer.pubkey], 1),
      metadata(relay, channel, "Room", 1),
      first,
      second,
    ]);
    await owner.session.unread.ensure();
    render(
      <UnreadBadge
        session={owner.session}
        channelId={channel}
        dm
        label="Room"
      />,
    );
    expect(
      screen.getByRole("img", { name: "2 unread messages." }),
    ).toBeVisible();
    const write = deferredSidebar<IntentOutcome[]>();
    bff.api.write.mockImplementationOnce(() => write.promise);
    persistence = deferredSidebar<void>();
    let action!: Promise<unknown>;
    await act(async () => {
      action = owner.session.unread.markChannelRead(channel);
    });
    // Opaque anchors cannot clear summaries while the transaction is held.
    expect(screen.getByRole("img")).toBeVisible();
    expect(bff.api.write).not.toHaveBeenCalled();
    await act(async () => {
      persistence?.resolve();
      await action;
    });
    persistence = undefined;
    // Both count and presentation remain relay-authoritative.
    expect(
      owner.session.unread.snapshot({ kind: "channel", channelId: channel })
        .unread,
    ).toEqual({ status: "exact", value: 2 });
    await waitFor(() => expect(bff.api.write).toHaveBeenCalledTimes(1));
    bff.api.sidebar.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      write.resolve([{ status: "applied" }]);
    });
    await waitFor(() =>
      expect(owner.session.unread.sync().error).toBe("offline"),
    );
    expect(screen.getByRole("img")).toBeVisible();

    const oldRefresh = deferredSidebar<SidebarPage>();
    bff.api.sidebar.mockImplementationOnce(() => oldRefresh.promise);
    let refresh!: Promise<void>;
    const calls = bff.api.sidebar.mock.calls.length;
    act(() => {
      refresh = owner.session.unread.refresh();
    });
    await waitFor(() =>
      expect(bff.api.sidebar).toHaveBeenCalledTimes(calls + 1),
    );
    const newerWrite = deferredSidebar<IntentOutcome[]>();
    bff.api.write.mockImplementationOnce(() => newerWrite.promise);
    await act(async () => {
      await owner.session.unread.markChannelRead(channel);
    });
    await waitFor(() => expect(bff.api.write).toHaveBeenCalledTimes(2));
    const newRefresh = deferredSidebar<SidebarPage>();
    bff.api.sidebar.mockImplementationOnce(() => newRefresh.promise);
    if (outcome === "applied") {
      await act(async () => {
        newerWrite.resolve([{ status: "applied" }]);
      });
      await waitFor(() => expect(bff.journal().pending).toHaveLength(0));
    }
    await act(async () => {
      oldRefresh.resolve({
        account: {
          retention_seconds: 2592000,
          cutoff_ms: 0,
        },
        channels: [row],
        next_cursor: null,
      });
      await refresh;
    });
    expect(screen.getByRole("img")).toBeVisible();
    if (outcome === "blocked") {
      await act(async () => {
        newerWrite.resolve([{ status: "blocked" }]);
      });
    }
    await act(async () => {
      newRefresh.resolve({
        account: {
          retention_seconds: 2592000,
          cutoff_ms: 0,
        },
        channels: [row],
        next_cursor: null,
      });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "2 unread messages." }),
      ).toBeVisible(),
    );
  },
);

it.each([
  { complete: false, count: "exact" as const },
  { complete: true, count: "at_least" as const },
  { complete: false, count: "at_least" as const },
])(
  "keeps an unresolved thread tail visible: %j",
  async ({ complete, count }) => {
    const bff = sidebarFixture(),
      viewer = keypair(),
      peer = keypair(),
      relay = keypair();
    const root = message(peer, channel, "root", 1);
    const anchor = message(peer, channel, "observed reply", 10, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ]);
    bff.rows.set(
      channel,
      sidebarRow(channel, {
        unread: { status: "at_least", value: 1 },
        attention: { status: "at_least", value: 1 },
        latest_message_id: anchor.id,
        latest_message_at: 10,
        latest_message_complete: false,
        threads: {
          complete,
          items: [
            {
              root_id: root.id,
              latest_reply_id: anchor.id,
              latest_reply_at: 10,
              unread: { status: count, value: 1 },
            },
          ],
        },
      }),
    );
    bff.messages.set(anchor.id, {
      message_id: anchor.id,
      status: "unread",
      reason: "conversation",
    });
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        sidebarApi: bff.api,
        query: async () => [],
        media: () => undefined,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { sidebarStorage: bff.storage },
    );
    owners.push(owner);
    live.receive([
      roster(relay, channel, [viewer.pubkey], 1),
      metadata(relay, channel, "Room", 1),
      root,
      anchor,
    ]);
    await owner.session.unread.ensure();
    const stop = owner.session.unread.subscribe(
      { kind: "message", channelId: channel, messageId: anchor.id },
      () => {},
    );
    await waitFor(() =>
      expect(
        owner.session.unread.snapshot({
          kind: "message",
          channelId: channel,
          messageId: anchor.id,
        }).unread,
      ).toEqual({ status: "exact", value: 1 }),
    );
    const row = foldMessages(channel, relay.pubkey, [root, anchor]).find(
      (r) => r.id === root.id,
    );
    if (!row) throw new Error("Expected the verified root row");
    render(
      <>
        <UnreadBadge
          session={owner.session}
          channelId={channel}
          dm
          label="Room"
        />
        <MessageRow
          row={{ ...row, replyCount: 2 }}
          unread={owner.session.unread}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          onOpenThread={() => {}}
        />
      </>,
    );
    const held = deferredSidebar<IntentOutcome[]>();
    bff.api.write.mockImplementationOnce(() => held.promise);
    try {
      await act(async () => {
        await owner.session.unread.markThrough(
          { kind: "thread", channelId: channel, rootId: root.id },
          anchor.id,
        );
      });
      await waitFor(() => expect(bff.api.write).toHaveBeenCalledTimes(1));
      expect(
        owner.session.unread.snapshot({
          kind: "message",
          channelId: channel,
          messageId: anchor.id,
        }).unreadVisible,
      ).toBe(false);
      expect(
        screen.getByRole("button", {
          name: /View thread: 2 replies.*1 unread replies/,
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("img", { name: "1 unread thread" }),
      ).toBeVisible();
      expect(
        owner.session.unread.snapshot({
          kind: "thread",
          channelId: channel,
          rootId: root.id,
        }).unread,
      ).toEqual({ status: count, value: 1 });
    } finally {
      held.resolve([{ status: "applied" }]);
      stop();
    }
  },
);

it("reconciles saturated applied operands while thread and DM badges await relay evidence", async () => {
  const bff = sidebarFixture(),
    viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  const dm = "11234567-89ab-cdef-0123-456789abcdef";
  const root = message(peer, channel, "root", 1);
  const anchor = message(peer, channel, "reply", 10, [
    ["e", root.id, "", "reply"],
  ]);
  const dmMessage = message(peer, dm, "DM", 10);
  const threadRow = sidebarRow(channel, {
    unread: { status: "exact", value: 1 },
    attention: { status: "exact", value: 1 },
    latest_message_id: anchor.id,
    latest_message_at: 10,
    threads: {
      complete: true,
      items: [
        {
          root_id: root.id,
          latest_reply_id: anchor.id,
          latest_reply_at: 10,
          unread: { status: "exact", value: 1 },
        },
      ],
    },
  });
  const dmRow = sidebarRow(dm, {
    unread: { status: "exact", value: 1 },
    attention: { status: "exact", value: 1 },
    latest_message_id: dmMessage.id,
    latest_message_at: 10,
  });
  bff.rows.set(channel, threadRow);
  bff.rows.set(dm, dmRow);
  await bff.storage.update(() => ({
    manual: [],
    pending: [
      ...Array.from({ length: 999 }, (_, n) => ({
        id: `prefix-${n}`,
        intent: {
          type: "mark_through" as const,
          target: {
            channel_id: channel,
            root_id: n === 0 ? root.id : n.toString(16).padStart(64, "0"),
          },
          message_id: anchor.id,
        },
      })),
      {
        id: "dm-cut",
        intent: {
          type: "mark_channel_read" as const,
          channel_id: dm,
          message_id: dmMessage.id,
        },
      },
    ],
  }));
  const initial = deferredSidebar<SidebarPage>();
  bff.api.sidebar.mockImplementationOnce(() => initial.promise);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      sidebarApi: bff.api,
      query: async () => [],
      media: () => undefined,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { sidebarStorage: bff.storage },
  );
  owners.push(owner);
  live.receive([
    roster(relay, channel, [viewer.pubkey], 1),
    metadata(relay, channel, "Room", 1),
    roster(relay, dm, [viewer.pubkey], 1),
    metadata(relay, dm, "DM", 1),
    root,
    anchor,
    dmMessage,
  ]);
  const loading = owner.session.unread.ensure();
  await waitFor(() => expect(bff.api.sidebar).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(bff.journal().pending).toHaveLength(0));
  // The initial response predates every applied operand and cannot settle them.
  const refreshing = deferredSidebar<SidebarPage>();
  bff.api.sidebar.mockRejectedValue(
    new Error("initial reconciliation offline"),
  );
  initial.resolve({
    account: { retention_seconds: 2592000, cutoff_ms: 0 },
    channels: [threadRow, dmRow],
    next_cursor: null,
  });
  await loading;
  // Drain the invalidation from the initial batch so it cannot accidentally
  // satisfy the later assertion that saturation schedules its own recovery.
  await waitFor(() =>
    expect(owner.session.unread.sync().error).toBe(
      "initial reconciliation offline",
    ),
  );
  const beforeSaturation = bff.api.sidebar.mock.calls.length;
  bff.api.sidebar.mockImplementation(() => refreshing.promise);
  const row = foldMessages(channel, relay.pubkey, [root])[0];
  if (!row) throw new Error("Expected the verified root row");
  render(
    <>
      <UnreadBadge session={owner.session} channelId={dm} dm label="DM" />
      <MessageRow
        row={{ ...row, replyCount: 2 }}
        unread={owner.session.unread}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        onOpenThread={() => {}}
      />
    </>,
  );
  expect(screen.getByRole("img", { name: /^1 unread messages/ })).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: /View thread: 2 replies.*1 unread replies/,
    }),
  ).toBeVisible();
  await act(async () => {
    await owner.session.unread.markThrough(
      { kind: "thread", channelId: channel, rootId: root.id },
      anchor.id,
    );
  });
  await waitFor(() =>
    expect(owner.session.unread.sync().writeError).toContain(
      "presentation capacity",
    ),
  );
  expect(bff.journal().pending).toHaveLength(1);
  expect(screen.getByRole("img", { name: /^1 unread messages/ })).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: /View thread: 2 replies.*1 unread replies/,
    }),
  ).toBeVisible();
  // Saturation itself must schedule applicable reads, without a user refresh.
  await waitFor(() =>
    expect(bff.api.sidebar.mock.calls.length).toBeGreaterThan(beforeSaturation),
  );
  expect(bff.api.sidebar.mock.calls[beforeSaturation]?.[0]).toHaveProperty(
    "channel_ids",
  );
  const clearedThread = {
    ...threadRow,
    unread: { status: "exact" as const, value: 0 },
    attention: { status: "exact" as const, value: 0 },
    threads: { complete: true, items: [] },
  };
  const clearedDm = {
    ...dmRow,
    unread: { status: "exact" as const, value: 0 },
    attention: { status: "exact" as const, value: 0 },
  };
  await act(async () => {
    refreshing.resolve({
      account: {
        retention_seconds: 2592000,
        cutoff_ms: 0,
      },
      channels: [clearedThread, clearedDm],
      next_cursor: null,
    });
  });
  await waitFor(() =>
    expect(
      owner.session.unread.snapshot({ kind: "channel", channelId: dm }).unread,
    ).toEqual({ status: "exact", value: 0 }),
  );
  await act(async () => {
    await owner.session.unread.retrySync();
  });
  expect(bff.journal().pending).toHaveLength(0);
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByRole("button", { name: "View thread: 2 replies" }),
  ).toBeVisible();
});

// Real session subscriptions and journal transactions; only the persistence
// boundary is gated so the pending paint cannot be explained by fast storage.
it.each([
  { first: "mark", failNewer: false },
  { first: "mark", failNewer: true },
  { first: "clear", failNewer: false },
  { first: "clear", failNewer: true },
] as const)(
  "manual badge invocation order and rollback: %j",
  async ({ first, failNewer }) => {
    const bff = sidebarFixture(),
      viewer = keypair(),
      relay = keypair();
    const target = { kind: "channel", channelId: channel } as const;
    bff.rows.set(
      channel,
      sidebarRow(channel, {
        unread: { status: "exact", value: 0 },
        attention: { status: "exact", value: 0 },
      }),
    );
    // A complete empty channel has no relay anchor: the real channel-read
    // action clears local intent without manufacturing a relay write.
    let gate: ReturnType<typeof deferredSidebar<void>> | undefined;
    let started: ReturnType<typeof deferredSidebar<void>> | undefined;
    let saves = 0;
    const storage = {
      ...bff.storage,
      async update(change: Parameters<typeof bff.storage.update>[0]) {
        if (gate) {
          started?.resolve();
          await gate.promise;
          if (++saves === 2 && failNewer) throw new Error("manual save failed");
        }
        return bff.storage.update(change);
      },
    };
    function session() {
      let live!: LiveCallbacks;
      const owner = createRelaySession(
        {
          viewer: viewer.pubkey,
          relayAuthor: relay.pubkey,
          sidebarApi: bff.api,
          query: async () => [],
          media: () => undefined,
          subscribe(callbacks) {
            live = callbacks;
            return { update() {}, retry() {}, dispose() {} };
          },
        },
        { sidebarStorage: storage },
      );
      owners.push(owner);
      live.receive([
        roster(relay, channel, [viewer.pubkey], 1),
        metadata(relay, channel, "Room", 1),
      ]);
      return owner;
    }
    const owner = session();
    await owner.session.unread.ensure();
    if (first === "clear") await owner.session.unread.markUnreadLocal(target);
    const mounted = render(
      <UnreadBadge session={owner.session} channelId={channel} label="Room" />,
    );
    const painted = () =>
      screen.queryByRole("img", {
        name: "Marked unread on this device only",
      }) !== null;
    expect(painted()).toBe(first === "clear");
    const initial = structuredClone(bff.journal().manual);
    gate = deferredSidebar<void>();
    started = deferredSidebar<void>();
    let older!: Promise<unknown>, newer!: Promise<unknown>;
    try {
      await act(async () => {
        older =
          first === "mark"
            ? owner.session.unread.markUnreadLocal(target)
            : owner.session.unread.markChannelRead(channel);
        await started?.promise;
      });
      expect(painted()).toBe(first === "mark");
      await act(async () => {
        newer =
          first === "mark"
            ? owner.session.unread.markChannelRead(channel)
            : owner.session.unread.markUnreadLocal(target);
      });
      expect(painted()).toBe(first === "clear");
      expect(bff.journal().manual).toEqual(initial);
      expect(bff.api.write).not.toHaveBeenCalled();
      await act(async () => {
        const settled = failNewer
          ? expect(newer).rejects.toThrow("manual save failed")
          : newer;
        gate?.resolve();
        await older;
        await settled;
      });
      const expected = failNewer ? first === "mark" : first === "clear";
      expect(painted()).toBe(expected);
      expect(bff.journal().manual).toEqual(expected ? [target] : []);
      expect(owner.session.unread.snapshot(target).unread).toEqual({
        status: "exact",
        value: 0,
      });
      // A new owner restores only the committed set, not transient edits.
      gate = undefined;
      mounted.unmount();
      owner.dispose();
      const restored = session();
      await restored.session.unread.ensure();
      render(
        <UnreadBadge
          session={restored.session}
          channelId={channel}
          label="Room"
        />,
      );
      expect(painted()).toBe(expected);
    } finally {
      gate?.resolve();
      await Promise.allSettled([older, newer]);
    }
  },
);
