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
  "paints before persistence, retains failed-refresh coverage, and fences a newer %s cut",
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
    // Paint changes while the strict transaction is still held, not just before HTTP.
    expect(screen.queryByRole("img")).toBeNull();
    expect(bff.api.write).not.toHaveBeenCalled();
    await act(async () => {
      persistence?.resolve();
      await action;
    });
    persistence = undefined;
    // The authoritative number is untouched even while its presentation is covered.
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
    expect(screen.queryByRole("img")).toBeNull();

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
    expect(screen.queryByRole("img")).toBeNull();
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
              attention: { status: count, value: 1 },
            },
          ],
        },
      }),
    );
    bff.messages.set(anchor.id, {
      message_id: anchor.id,
      status: "unread",
      attention: true,
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

it("reconciles saturated applied surfaces before retry without losing the thread or DM mask", async () => {
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
          attention: { status: "exact", value: 1 },
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
        createdAt: 10,
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
        createdAt: 10,
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
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByRole("button", { name: "View thread: 2 replies" }),
  ).toBeVisible();
  await act(async () => {
    await owner.session.unread.markThrough(
      { kind: "thread", channelId: channel, rootId: root.id },
      anchor.id,
    );
  });
  await waitFor(() =>
    expect(owner.session.unread.sync().error).toContain(
      "presentation capacity",
    ),
  );
  expect(bff.journal().pending).toHaveLength(1);
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByRole("button", { name: "View thread: 2 replies" }),
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
