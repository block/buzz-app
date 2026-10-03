import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type {
  SidebarDecoder,
  SidebarMuteMutator,
} from "../relay/sidebar-preferences";
import type { LiveCallbacks } from "../relay/live";
import type { ReadFilter } from "../relay/events";
import type { Communities } from "../communities/service";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
  flush,
} from "../relay/testing";
import {
  sidebarFixture,
  sidebarRow,
  sidebarAccount,
} from "../relay/sidebar-testing";
import type { RelayEvent } from "../relay/events";
import { NotificationsService } from "./service";
import { createNotificationPreferences } from "./preferences";
import { provideNavigation } from "../navigation/service";
import { bindMessageNotifications, notificationAuthorized } from "./messages";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function setup(
  readBarrier: Promise<void> = Promise.resolve(),
  readFrontier?: number,
  remote?: {
    barrier: Promise<void>;
    decodeBarrier?: Promise<void>;
    frontier: number;
    channelsMounted?: boolean;
    deferRoster?: boolean;
  },
  sidebar?: { decode: SidebarDecoder; write?: SidebarMuteMutator },
) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  const origin = "https://relay.example.com";
  let callbacks!: LiveCallbacks;
  const bff = sidebarFixture();
  const observed = new Map<string, RelayEvent>();
  let frontier = readFrontier ?? remote?.frontier;
  const sidebarQuery = vi.fn(async () => {
    await remote?.barrier;
    return {
      account: sidebarAccount,
      channels: [...bff.rows.values()],
      next_cursor: null,
    };
  });
  bff.api.sidebar.mockImplementation(sidebarQuery);
  const contextQuery = bff.api.contexts;
  contextQuery.mockImplementation(async (queries) => {
    await remote?.barrier;
    await remote?.decodeBarrier;
    return {
      account: sidebarAccount,
      contexts: queries.map((q) => ({
        status: "available",
        through_timestamp: frontier ?? null,
        messages: q.message_ids.map((message_id) => {
          const event = observed.get(message_id);
          if (!event) return { message_id, status: "unavailable" };
          if (
            event.pubkey === viewer.pubkey ||
            (frontier !== undefined && event.created_at <= frontier)
          )
            return { message_id, status: "read" };
          const channel = owner.session.channels
            .list()
            .channels.find((channel) => channel.id === q.target.channel_id);
          const mentioned = event.tags.some(
            ([key, value]) => key === "p" && value === viewer.pubkey,
          );
          return {
            message_id,
            status: "unread",
            reason:
              channel?.channelType === "dm"
                ? "direct"
                : mentioned
                  ? "mention"
                  : q.target.root_id
                    ? "conversation"
                    : null,
          };
        }),
      })),
    };
  });
  bff.api.write.mockImplementation(async (intents) => {
    for (const intent of intents) {
      const event = observed.get(intent.message_id);
      if (event) frontier = Math.max(frontier ?? -1, event.created_at);
    }
    return intents.map(() => ({ status: "applied" }));
  });
  const query = vi.fn(
    async (_filters: readonly ReadFilter[]) => [] as RelayEvent[],
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      sidebarApi: bff.api,
      ...(sidebar
        ? {
            decodeSidebarPreferences: sidebar.decode,
            ...(sidebar.write ? { writeSidebarMute: sidebar.write } : {}),
          }
        : {}),
      media: () => undefined,
      subscribe(value) {
        callbacks = value;
        callbacks.state({ status: "connected", routes: [] });
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      identityNames: {
        register() {},
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [createAgentDirectory()],
            subscribe: () => () => {},
          }),
      },
      sidebarStorage: {
        async update(change) {
          await readBarrier;
          return bff.storage.update(change);
        },
        close() {},
      },
    },
  );
  cleanups.push(owner.dispose);
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  cleanups.push(() => ctx.fiber.dispose());
  const navigation = provideNavigation(ctx);
  const data = new Map<string, string>();
  const preferences = createNotificationPreferences({
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window);
  let click = () => {};
  const show = vi.fn(async (_item, activate: () => void) => {
    click = activate;
  });
  const permission = vi.fn(async (): Promise<"granted"> => "granted");
  const listeners = new Set<() => void>();
  let selected: string | null = origin;
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const communities = {
    snapshot: () => ({
      status: "ready",
      viewer: viewer.pubkey,
      selected,
      memberships: [{ id: origin, name: "Example" }],
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    relay: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as Communities;
  const notifications = new NotificationsService(
    ctx,
    navigation.navigation,
    {
      label: "Test platform",
      permission,
      requestPermission: async () => "granted",
      show,
      dispose() {},
    },
    preferences,
    (target) => notificationAuthorized(communities, target),
  );
  const discover = () => {
    bff.rows.set(
      "01234567-89ab-cdef-0123-456789abcdef",
      sidebarRow("01234567-89ab-cdef-0123-456789abcdef"),
    );
    callbacks.receive([
      roster(relay, "01234567-89ab-cdef-0123-456789abcdef", [viewer.pubkey]),
      metadata(relay, "01234567-89ab-cdef-0123-456789abcdef", "Room"),
    ]);
  };
  // Channels starts the same shared observation once the roster is ready.
  if (remote?.channelsMounted) {
    discover();
    void owner.session.unread.ensure();
  }
  const stop = bindMessageNotifications(notifications, communities);
  cleanups.push(stop);
  await flush();
  // Names retain owner inventory independently of notification/roster startup.
  await vi.waitFor(() =>
    expect(owner.session.agentLibrary.snapshot().status).toBe("ready"),
  );
  notifications.updatePreferences({ sound: false });
  const emit = (
    events: ReturnType<typeof message>[],
    phase?: "replay" | "live",
    channelId = "01234567-89ab-cdef-0123-456789abcdef",
  ) => {
    for (const event of events) {
      if (event.kind === 5 || event.kind === 9005) {
        for (const [name, id] of event.tags)
          if (name === "e" && id) observed.delete(id);
      } else observed.set(event.id, event);
    }
    callbacks.receive(events, phase ? { phase, channelId } : undefined);
  };
  if (!remote?.channelsMounted && !remote?.deferRoster) discover();
  const make = (text: string, age = 0, author = peer) =>
    message(
      author,
      "01234567-89ab-cdef-0123-456789abcdef",
      text,
      Math.floor(Date.now() / 1000) - age,
      [["p", viewer.pubkey]],
    );
  return {
    owner,
    notifications,
    navigation,
    emit,
    make,
    async retain(row: RelayEvent) {
      const stop = owner.session.unread.subscribe(
        {
          kind: "message",
          channelId: "01234567-89ab-cdef-0123-456789abcdef",
          messageId: row.id,
        },
        () => {},
      );
      cleanups.push(stop);
      await vi.waitFor(() =>
        expect(
          owner.session.unread.attention(
            "01234567-89ab-cdef-0123-456789abcdef",
            row.id,
          ).status,
        ).not.toBe("unknown"),
      );
    },
    show,
    permission,
    query,
    sidebarQuery,
    bff,
    contextQuery,
    stop,
    discover,
    peer,
    relay,
    viewer,
    click: () => click(),
    deselect() {
      selected = null;
      for (const listener of listeners) listener();
    },
  };
}
it.each([9, 40002])(
  "only production live kind-%s traffic can notify, never history/replay/local observation",
  async (kind) => {
    // Keep second-rounded fixtures outside the cutoff while signing/admitting.
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const h = await setup();
    const original = h.make;
    h.make = (text, age = 0, author = h.peer) =>
      signed(author, { ...original(text, age, author), kind });
    const historic = h.make("finite");
    h.query.mockResolvedValueOnce([historic]);
    await h.owner.session.read([{ ids: [historic.id], limit: 1 }]);
    h.emit([historic], "live");
    h.emit([h.make("legacy")]);
    h.emit([h.make("replay")], "replay");
    h.emit([h.make("wrong route")], "live", "elsewhere");
    h.emit(
      [h.make("stale", 121), h.make("future", -31), h.make("own", 0, h.viewer)],
      "live",
    );
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    const fresh = h.make("fresh");
    h.emit([fresh, fresh], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
    await h.retain(fresh);
    h.click();
    expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
      messageId: fresh.id,
    });
    expect(
      h.owner.session.unread.attention(
        "01234567-89ab-cdef-0123-456789abcdef",
        fresh.id,
      ).unread,
    ).toBe(true);
  },
);
it.each(
  [9, 40002].flatMap((kind) =>
    [
      { age: -30001, allowed: false },
      { age: -30000, allowed: true },
      { age: 119999, allowed: true },
      { age: 120000, allowed: false },
      { age: 120001, allowed: false },
    ].map((boundary) => ({ kind, ...boundary })),
  ),
)(
  "live kind-$kind at age $age ms: notification allowed=$allowed",
  async ({ kind, age, allowed }) => {
    const createdAt = 1_780_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt * 1000 + age);
    const h = await setup();
    h.emit(
      [
        signed(h.peer, {
          kind,
          created_at: createdAt,
          content: "boundary",
          tags: [
            ["h", "01234567-89ab-cdef-0123-456789abcdef"],
            ["p", h.viewer.pubkey],
          ],
        }),
      ],
      "live",
    );
    await flush();
    expect(h.show).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);
it("live membership activity and observer telemetry never become message notifications", async () => {
  const h = await setup();
  h.emit(
    [
      signed(h.relay, {
        kind: 40099,
        content: JSON.stringify({
          type: "member_joined",
          actor: h.viewer.pubkey,
          target: h.peer.pubkey,
        }),
        tags: [
          ["h", "01234567-89ab-cdef-0123-456789abcdef"],
          ["p", h.viewer.pubkey],
        ],
      }),
      signed(h.peer, {
        kind: 24200,
        content: "opaque",
        tags: [
          ["h", "01234567-89ab-cdef-0123-456789abcdef"],
          ["p", h.viewer.pubkey],
        ],
      }),
    ],
    "live",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit([h.make("fresh after activity")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
});

it("viewing suppression uses the shared lease, and suppressed candidates never become delayed alerts", async () => {
  const h = await setup();
  const row = h.make("visible");
  const lease = h.owner.session.unread.reading(
    "01234567-89ab-cdef-0123-456789abcdef",
  );
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["01234567-89ab-cdef-0123-456789abcdef"], limit: 50 },
  ]);
  view.subscribe(() => lease.view([row.id], () => true));
  h.emit([row], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  lease.dispose();
  await h.notifications.requestPermission();
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  const next = h.make("visible allowed");
  const visible = h.owner.session.unread.reading(
    "01234567-89ab-cdef-0123-456789abcdef",
  );
  view.subscribe(() => visible.view([next.id], () => true));
  h.emit([next], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  visible.dispose();
  view.dispose();
});
it("community switching stops new production but keeps prior scoped click intent", async () => {
  const h = await setup();
  const row = h.make("fresh");
  h.emit([row], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  h.deselect();
  h.click();
  // The real host navigation will select/check the target community and channel;
  // this service must not silently discard it because another community is selected.
  expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
    kind: "conversation",
    messageId: row.id,
    scope: { viewer: h.viewer.pubkey },
  });
  h.emit([h.make("unselected")], "live");
  await flush();
  expect(h.show).toHaveBeenCalledTimes(1);
});
it("authorized deletions in the same live batch cannot generate an alert", async () => {
  const h = await setup();
  const row = h.make("deleted");
  h.emit(
    [
      row,
      signed(h.peer, {
        kind: 5,
        tags: [["e", row.id]],
        content: "",
        created_at: row.created_at,
      }),
    ],
    "live",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
});

it("review: fresh incoming alert waits for initial unread readiness rather than becoming permanently quiet", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(ready);
  try {
    expect(h.owner.session.unread.sync().status).toBe("loading");
    const row = h.make("arrived during startup");
    h.emit([row], "live");
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    release();
    await flush();
    expect(h.owner.session.unread.sync().status).toBe("reconciled");
    await h.retain(row);
    expect(
      h.owner.session.unread.attention(
        "01234567-89ab-cdef-0123-456789abcdef",
        row.id,
      ),
    ).toMatchObject({
      status: "eligible",
      unread: true,
    });
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  } finally {
    release();
  }
});

it.each([
  "already-read",
  "expired",
  "revoked",
  "muted",
  "viewed",
  "switched",
] as const)(
  "a loading live candidate stays quiet after readiness when %s",
  async (condition) => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const now = Date.now();
    const h = await setup(
      barrier,
      condition === "already-read" ? Math.floor(now / 1000) + 10 : undefined,
    );
    try {
      const row = h.make("pending at startup");
      h.emit([row], "live");
      await flush();
      if (condition === "expired")
        vi.spyOn(Date, "now").mockReturnValue(now + 121000);
      if (condition === "revoked")
        h.emit([
          roster(
            h.relay,
            "01234567-89ab-cdef-0123-456789abcdef",
            [],
            Math.floor(now / 1000),
          ),
        ]);
      if (condition === "muted")
        h.notifications.updatePreferences({ enabled: false });
      if (condition === "switched") h.deselect();
      if (condition === "viewed") {
        const lease = h.owner.session.unread.reading(
          "01234567-89ab-cdef-0123-456789abcdef",
        );
        lease.view([row.id], () => true);
        cleanups.push(lease.dispose);
      }
      release();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      await h.notifications.requestPermission();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

it("review: channel revoke/regrant plus history restoration must not revive a pending live alert", async () => {
  const h = await setup();
  let finish!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const row = h.make("pending before access removal");
  h.emit([row], "live");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const now = Math.floor(Date.now() / 1000);
  h.emit([
    roster(h.relay, "01234567-89ab-cdef-0123-456789abcdef", [], now + 1),
  ]);
  h.emit([
    roster(
      h.relay,
      "01234567-89ab-cdef-0123-456789abcdef",
      [h.viewer.pubkey],
      now + 2,
    ),
  ]);
  h.query.mockResolvedValueOnce([row]);
  await h.owner.session.read([{ ids: [row.id], limit: 1 }]);
  await h.retain(row);
  expect(
    h.owner.session.unread.attention(
      "01234567-89ab-cdef-0123-456789abcdef",
      row.id,
    ),
  ).toMatchObject({
    status: "eligible",
    unread: true,
  });
  finish("granted");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
});

it("live message wiring supplies the signed author and body, resolving names at delivery without extra reads", async () => {
  const h = await setup();
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const row = h.make("**Hello** [Wes](https://example.com/private)");
  h.emit([row], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  // Profile can arrive from the existing shared stream while permission is pending.
  h.emit([profile(h.peer, { display_name: "Pinky" })]);
  release("granted");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0]).toMatchObject({
    title: "Pinky mentioned you in #Room",
    body: "Hello Wes",
  });
  expect(h.query.mock.calls.map(([filters]) => filters)).toEqual([
    [{ authors: [h.viewer.pubkey], kinds: [30175, 30177], limit: 200 }],
  ]);
});

it.each([
  [9, "direct"],
  [9, "thread"],
  [40002, "direct"],
  [40002, "thread"],
] as const)(
  "live kind-%s %s messages carry the correct title and preview",
  async (kind, category) => {
    const h = await setup();
    h.emit([profile(h.peer, { name: "Pinky" })]);
    const now = Math.floor(Date.now() / 1000);
    const root = message(
      h.viewer,
      "01234567-89ab-cdef-0123-456789abcdef",
      "Own thread",
      now - 1,
    );
    if (category === "direct") {
      h.emit([
        signed(h.relay, {
          kind: 39000,
          content: JSON.stringify({
            name: "internal-dm-id",
            channel_type: "dm",
          }),
          tags: [
            ["d", "01234567-89ab-cdef-0123-456789abcdef"],
            ["name", "internal-dm-id"],
            ["t", "dm"],
          ],
          created_at: now,
        }),
      ]);
    } else h.emit([root], "replay");
    const row = signed(h.peer, {
      kind,
      content:
        kind === 40002
          ? JSON.stringify({ content: "A **new** reply" })
          : "A **new** reply",
      created_at: now,
      tags: [
        ["h", "01234567-89ab-cdef-0123-456789abcdef"],
        ...(category === "thread" ? [["e", root.id, "", "reply"]] : []),
      ],
    });
    h.emit([row], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0]).toMatchObject({
      title:
        category === "direct"
          ? "Pinky sent you a direct message"
          : "Pinky replied in #Room",
      body: "A new reply",
    });
  },
);

it("classifies p-tagged DM messages as direct, not mention", async () => {
  const h = await setup();
  h.emit([profile(h.peer, { name: "Pinky" })]);
  const now = Math.floor(Date.now() / 1000);
  h.emit([
    signed(h.relay, {
      kind: 39000,
      content: JSON.stringify({ name: "internal-dm-id", channel_type: "dm" }),
      tags: [
        ["d", "01234567-89ab-cdef-0123-456789abcdef"],
        ["name", "internal-dm-id"],
        ["t", "dm"],
      ],
      created_at: now,
    }),
  ]);
  // Agent and CLI DM traffic p-tags the recipient; that must not reroute the
  // message to the mention category (label, sound, and preference toggle).
  h.emit([h.make("hello")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].title).toBe(
    "Pinky sent you a direct message",
  );
});

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([false, true])(
  "waits for server contexts (Channels consumer=%s), then revalidates retained live candidates",
  async (channelsMounted) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const sidebar = deferred(),
      context = deferred();
    const h = await setup(Promise.resolve(), undefined, {
      channelsMounted,
      barrier: sidebar.promise,
      decodeBarrier: context.promise,
      frontier: Math.floor(Date.now() / 1000) - 1,
    });
    try {
      await vi.waitFor(() => expect(h.sidebarQuery).toHaveBeenCalledOnce());
      expect(h.owner.session.unread.sync()).toMatchObject({
        status: "loading",
        completeness: "unknown",
      });
      const read = h.make("already read on another device", 1),
        unread = h.make("genuinely unread");
      h.emit([read, unread], "live");
      await flush();
      expect(
        h.owner.session.unread.attention(
          "01234567-89ab-cdef-0123-456789abcdef",
          read.id,
        ).status,
      ).toBe("unknown");
      expect(h.show).not.toHaveBeenCalled();
      sidebar.release();
      await vi.waitFor(() => expect(h.contextQuery).toHaveBeenCalled());
      expect(h.show).not.toHaveBeenCalled();
      context.release();
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
      expect(h.owner.session.unread.sync()).toMatchObject({
        status: "reconciled",
        completeness: "snapshot",
      });
      expect(h.show.mock.calls[0]?.[0]).toMatchObject({
        body: "genuinely unread",
      });
      expect(h.sidebarQuery).toHaveBeenCalledOnce();
      h.contextQuery.mockClear();
      await h.owner.session.unread.refresh();
      expect(h.contextQuery).not.toHaveBeenCalled(); // terminal candidates release demand
    } finally {
      sidebar.release();
      context.release();
    }
  },
);
it.each(["failed", "cancelled", "switched", "disposed"] as const)(
  "server context observation keeps candidates quiet when %s",
  async (condition) => {
    const sidebar = deferred();
    const h = await setup(Promise.resolve(), undefined, {
      barrier: sidebar.promise,
      frontier: 0,
    });
    try {
      await vi.waitFor(() => expect(h.sidebarQuery).toHaveBeenCalledOnce());
      if (condition === "failed" || condition === "cancelled")
        h.contextQuery.mockRejectedValue(
          condition === "failed"
            ? new Error("context unavailable")
            : new DOMException("cancelled", "AbortError"),
        );
      h.emit([h.make("pending remote state")], "live");
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      if (condition === "switched") h.deselect();
      if (condition === "disposed") h.stop();
      sidebar.release();
      await h.owner.session.unread.ensure();
      if (condition === "failed")
        expect(h.owner.session.unread.sync().status).toBe("error");
      await h.notifications.requestPermission();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      expect(h.sidebarQuery).toHaveBeenCalledOnce();
    } finally {
      sidebar.release();
    }
  },
);

it.each([
  [
    JSON.stringify({ content: "**Decoded** preview", extra: "not displayed" }),
    "Decoded preview",
  ],
  [
    JSON.stringify({
      extra: "x".repeat(5000),
      content: "Text after envelope metadata",
    }),
    "Text after envelope metadata",
  ],
  [JSON.stringify({ content: "Long ".repeat(1000) }), null],
  ["Plain text fallback", "Plain text fallback"],
  [JSON.stringify({ content: "" }), "New message"],
])(
  "kind-40002 mentions decode their envelope before bounding the preview (case %#)",
  async (content, body) => {
    const h = await setup();
    const event = signed(h.peer, { ...h.make(content), kind: 40002 });
    h.emit([event], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    const shown = h.show.mock.calls[0]?.[0];
    if (body !== null) expect(shown.body).toBe(body);
    else {
      expect([...shown.body].length).toBeLessThanOrEqual(200);
      expect(shown.body.startsWith("Long Long")).toBe(true);
    }
  },
);

it("notification startup waits for the roster without consuming the shared sidebar traversal early", async () => {
  const h = await setup(Promise.resolve(), undefined, {
    barrier: Promise.resolve(),
    frontier: 0,
    deferRoster: true,
  });
  expect(h.sidebarQuery).not.toHaveBeenCalled();
  expect(h.query.mock.calls.map(([filters]) => filters)).toEqual([
    [{ authors: [h.viewer.pubkey], kinds: [30175, 30177], limit: 200 }],
  ]);
  h.discover();
  await h.owner.session.unread.ensure();
  expect(h.sidebarQuery).toHaveBeenCalledOnce();
  expect(
    h.query.mock.calls.filter(([filters]) => filters[0]?.kinds?.includes(9)),
  ).toEqual([]);
  await h.owner.session.unread.ensure();
  expect(h.sidebarQuery).toHaveBeenCalledOnce();
});

it("scopes notification author collisions to the message channel", async () => {
  const h = await setup();
  const stranger = keypair();
  h.emit([
    profile(h.peer, { name: "Pinky" }),
    profile(stranger, { name: "Pinky" }),
  ]);
  h.emit([h.make("first scoped notification")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  expect(h.show.mock.calls[0]?.[0].title).toContain("Pinky");
  expect(h.show.mock.calls[0]?.[0].title).not.toContain(" · ");
  h.emit([
    roster(
      h.relay,
      "01234567-89ab-cdef-0123-456789abcdef",
      [h.viewer.pubkey, h.peer.pubkey, stranger.pubkey],
      Math.floor(Date.now() / 1000) + 1,
    ),
  ]);
  h.emit([h.make("second scoped notification")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  expect(h.show.mock.calls[1]?.[0].title).toContain("Pinky · ");
});

it.each(["direct", "thread"] as const)(
  "confirmed mute suppresses %s alerts but preserves unread and explicit mentions",
  async (category) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const write = vi.fn<SidebarMuteMutator>(async ({ muted }) =>
      muted ? ["01234567-89ab-cdef-0123-456789abcdef"] : [],
    );
    const h = await setup(Promise.resolve(), undefined, undefined, {
      decode: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
      }),
      write,
    });
    await h.owner.session.sidebarPreferences.ensure();
    const root = message(
      h.viewer,
      "01234567-89ab-cdef-0123-456789abcdef",
      "root",
      1_779_999_999,
    );
    if (category === "direct")
      h.emit([
        signed(h.relay, {
          kind: 39000,
          created_at: 1_780_000_000,
          content: JSON.stringify({ name: "Room", channel_type: "dm" }),
          tags: [
            ["d", "01234567-89ab-cdef-0123-456789abcdef"],
            ["name", "Room"],
            ["t", "dm"],
          ],
        }),
      ]);
    else h.emit([root], "replay");
    const make = (text: string) =>
      message(
        h.peer,
        "01234567-89ab-cdef-0123-456789abcdef",
        text,
        1_780_000_000,
        category === "thread" ? [["e", root.id, "", "reply"]] : [],
      );
    await h.owner.session.sidebarPreferences.setMute(
      "01234567-89ab-cdef-0123-456789abcdef",
      true,
    );
    const quiet = make("quiet");
    h.emit([quiet], "live");
    // Mention is an observable presentation barrier behind the muted candidate.
    h.emit([h.make("mention")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("mention");
    await h.retain(quiet);
    expect(
      h.owner.session.unread.attention(
        "01234567-89ab-cdef-0123-456789abcdef",
        quiet.id,
      ).unread,
    ).toBe(true);
    await h.owner.session.sidebarPreferences.setMute(
      "01234567-89ab-cdef-0123-456789abcdef",
      false,
    );
    h.emit([make("audible")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    expect(h.show.mock.calls[1]?.[0].body).toBe("audible");
  },
);

it("a confirmed mute cancels an alert waiting on permission, even after unmute", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
  const h = await setup(Promise.resolve(), undefined, undefined, {
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    write: async ({ muted }) =>
      muted ? ["01234567-89ab-cdef-0123-456789abcdef"] : [],
  });
  await h.owner.session.sidebarPreferences.ensure();
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const root = message(
    h.viewer,
    "01234567-89ab-cdef-0123-456789abcdef",
    "root",
    1_779_999_999,
  );
  const reply = message(
    h.peer,
    "01234567-89ab-cdef-0123-456789abcdef",
    "cancelled reply",
    1_780_000_000,
    [["e", root.id, "", "reply"]],
  );
  h.emit([root], "replay");
  h.emit([reply], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  try {
    await h.owner.session.sidebarPreferences.setMute(
      "01234567-89ab-cdef-0123-456789abcdef",
      true,
    );
    await h.owner.session.sidebarPreferences.setMute(
      "01234567-89ab-cdef-0123-456789abcdef",
      false,
    );
  } finally {
    release("granted");
  }
  // A fresh candidate drains the presentation turn after permission resolves.
  h.emit([h.make("fresh mention")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("fresh mention");
  await h.retain(reply);
  expect(
    h.owner.session.unread.attention(
      "01234567-89ab-cdef-0123-456789abcdef",
      reply.id,
    ).unread,
  ).toBe(true);
});

it.each([true, false])(
  "initial mute read failure holds ordinary alerts until explicit retry (muted=%s), without Channels mounted",
  async (muted) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const decode = vi
      .fn<SidebarDecoder>()
      .mockRejectedValueOnce(new Error("preferences unavailable"))
      .mockResolvedValue({
        sections: [],
        assignments: {},
        starred: [],
        muted: muted ? ["01234567-89ab-cdef-0123-456789abcdef"] : [],
      });
    const h = await setup(Promise.resolve(), undefined, undefined, { decode });
    await h.owner.session.sidebarPreferences.ensure();
    expect(h.owner.session.sidebarPreferences.snapshot().status).toBe("error");
    const root = message(
      h.viewer,
      "01234567-89ab-cdef-0123-456789abcdef",
      "root",
      1_779_999_999,
    );
    h.emit([root], "replay");
    const reply = message(
      h.peer,
      "01234567-89ab-cdef-0123-456789abcdef",
      "waiting",
      1_780_000_000,
      [["e", root.id, "", "reply"]],
    );
    h.emit([reply], "live");
    // A mention bypasses only mute readiness, not existing read/permission policy.
    h.emit([h.make("mention")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("mention");
    await h.owner.session.sidebarPreferences.refresh();
    if (!muted) await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    else {
      h.emit([h.make("second mention")], "live");
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
      expect(h.show.mock.calls[1]?.[0].body).toBe("second mention");
    }
    expect(decode).toHaveBeenCalledTimes(2);
  },
);

it("alerts a fresh mention beside loaded thread history without bulk context demand", async () => {
  const h = await setup();
  const threadChannel = "11234567-89ab-cdef-0123-456789abcdef";
  h.emit([
    roster(h.relay, threadChannel, [h.viewer.pubkey]),
    metadata(h.relay, threadChannel, "Large thread"),
  ]);
  const root = message(h.peer, threadChannel, "root", 1);
  const replies = Array.from({ length: 1101 }, (_, i) =>
    message(h.peer, threadChannel, `reply ${i}`, i + 2, [
      ["e", root.id, "", "root"],
    ]),
  );
  h.emit([root, ...replies]);
  // Thread branch presentation no longer retains per-message unread selectors.
  expect(
    h.owner.session.unread.attention(threadChannel, replies[0]?.id ?? "")
      .status,
  ).toBe("unknown");
  const mention = h.make("Mention beside a large thread");
  h.emit([mention], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
});

// M01–M03: relay uncertainty replaces #471's parent-lookup machinery.
it.each(["conversation", "not_counted"] as const)(
  "retains a live unknown reply, re-queries on refresh and settles %s without history alerts",
  async (settled) => {
    const h = await setup();
    const channel = "01234567-89ab-cdef-0123-456789abcdef";
    const root = message(h.peer, channel, "old parent", 10);
    const reply = message(
      h.peer,
      channel,
      "fresh answer",
      Math.floor(Date.now() / 1000),
      [
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
      ],
    );
    let resolved = false;
    h.contextQuery.mockImplementation(async (queries) => ({
      account: sidebarAccount,
      contexts: queries.map((q) => ({
        status: "available",
        through_timestamp: null,
        messages: q.message_ids.map((message_id) =>
          !resolved
            ? { message_id, status: "unknown" }
            : settled === "conversation"
              ? { message_id, status: "unread", reason: "conversation" }
              : { message_id, status: "not_counted" },
        ),
      })),
    }));
    h.emit([root], "replay");
    h.emit([reply], "live");
    await h.owner.session.unread.refresh();
    expect(
      h.contextQuery.mock.calls.flatMap(([queries]) =>
        queries.flatMap((q) => q.message_ids),
      ),
    ).toContain(reply.id);
    expect(h.show).not.toHaveBeenCalled();
    const before = h.contextQuery.mock.calls.length;
    resolved = true;
    await h.owner.session.unread.refresh();
    expect(h.contextQuery.mock.calls.length).toBeGreaterThan(before);
    if (settled === "conversation") {
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
      expect(h.show.mock.calls[0]?.[0].body).toBe("fresh answer");
    } else {
      // Drain the same notification presentation queue with a known live mention.
      const mention = h.make("barrier mention");
      h.contextQuery.mockImplementation(async (queries) => ({
        account: sidebarAccount,
        contexts: queries.map((q) => ({
          status: "available",
          through_timestamp: null,
          messages: q.message_ids.map((message_id) =>
            message_id === mention.id
              ? { message_id, status: "unread", reason: "mention" }
              : { message_id, status: "not_counted" },
          ),
        })),
      }));
      h.emit([mention], "live");
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
      expect(h.show.mock.calls[0]?.[0].body).toBe("barrier mention");
    }
    const history = message(
      h.peer,
      channel,
      "history only",
      Math.floor(Date.now() / 1000),
      [["e", root.id, "", "reply"]],
    );
    h.emit([history], "replay");
    await h.owner.session.unread.refresh();
    expect(h.show).toHaveBeenCalledTimes(1);
    expect(
      h.query.mock.calls
        .flatMap(([filters]) => filters)
        .some((f) => f.authors && f["#e"]),
    ).toBe(false);
  },
);

it("keeps broadcast quiet but allows a fresh authoritative conversation upgrade", async () => {
  const h = await setup();
  const channel = "01234567-89ab-cdef-0123-456789abcdef";
  const reply = message(
    h.peer,
    channel,
    "broadcast answer",
    Math.floor(Date.now() / 1000),
    [
      ["e", "a".repeat(64), "", "reply"],
      ["broadcast", "1"],
    ],
  );
  let reason: "broadcast" | "conversation" = "broadcast";
  h.contextQuery.mockImplementation(async (queries) => ({
    account: sidebarAccount,
    contexts: queries.map((q) => ({
      status: "available",
      through_timestamp: null,
      messages: q.message_ids.map((message_id) => ({
        message_id,
        status: "unread",
        reason,
      })),
    })),
  }));
  h.emit([reply], "live");
  await h.owner.session.unread.refresh();
  expect(h.owner.session.unread.attention(channel, reply.id)).toMatchObject({
    status: "eligible",
    unread: true,
  });
  expect(
    h.owner.session.unread.attention(channel, reply.id).category,
  ).toBeUndefined();
  expect(h.show).not.toHaveBeenCalled();
  reason = "conversation";
  await h.owner.session.unread.refresh();
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
});

it("expires classification and admitted permission waits at the original event deadline", async () => {
  const h = await setup();
  vi.useFakeTimers();
  vi.setSystemTime(1_780_000_000_000);
  const reply = h.make("late classification");
  let resolved = false;
  h.contextQuery.mockImplementation(async (queries) => ({
    account: sidebarAccount,
    contexts: queries.map((q) => ({
      status: "available",
      through_timestamp: null,
      messages: q.message_ids.map((message_id) =>
        resolved
          ? { message_id, status: "unread", reason: "mention" }
          : { message_id, status: "unknown" },
      ),
    })),
  }));
  let permit!: (permission: "granted") => void;
  h.permission.mockImplementation(
    () =>
      new Promise((resolve) => {
        permit = resolve;
      }),
  );
  h.emit([reply], "live");
  await h.owner.session.unread.refresh();
  vi.setSystemTime(1_780_000_119_000);
  resolved = true;
  await h.owner.session.unread.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(permit).toBeTypeOf("function");
  await vi.advanceTimersByTimeAsync(1000);
  permit("granted");
  await vi.advanceTimersByTimeAsync(0);
  expect(h.show).not.toHaveBeenCalled();
  h.contextQuery.mockClear();
  await h.owner.session.unread.refresh();
  expect(h.contextQuery).not.toHaveBeenCalled();
});

it.each(["expiry", "session", "access", "disabled"] as const)(
  "releases pre-admission unknown demand on %s",
  async (end) => {
    const h = await setup();
    vi.useFakeTimers();
    vi.setSystemTime(1_780_000_000_000);
    const row = h.make("undecided");
    h.contextQuery.mockImplementation(async (queries) => ({
      account: sidebarAccount,
      contexts: queries.map((q) => ({
        status: "available",
        through_timestamp: null,
        messages: q.message_ids.map((message_id) => ({
          message_id,
          status: "unknown",
        })),
      })),
    }));
    h.emit([row], "live");
    await h.owner.session.unread.refresh();
    expect(h.contextQuery).toHaveBeenCalled();
    if (end === "expiry") await vi.advanceTimersByTimeAsync(120000);
    else if (end === "session") h.deselect();
    else if (end === "disabled") {
      h.notifications.updatePreferences({ enabled: false });
      h.notifications.updatePreferences({ enabled: true });
    } else {
      h.emit([
        roster(
          h.relay,
          "01234567-89ab-cdef-0123-456789abcdef",
          [],
          1_780_000_001,
        ),
      ]);
      h.emit([
        roster(
          h.relay,
          "01234567-89ab-cdef-0123-456789abcdef",
          [h.viewer.pubkey],
          1_780_000_002,
        ),
      ]);
    }
    h.contextQuery.mockClear();
    await h.owner.session.unread.refresh();
    expect(h.contextQuery).not.toHaveBeenCalled();
    expect(h.show).not.toHaveBeenCalled();
  },
);

it.each(["capacity", "observation"] as const)(
  "rejects a live candidate once on %s failure and releases its context",
  async (failure) => {
    const h = await setup();
    vi.useFakeTimers();
    vi.setSystemTime(1_780_000_000_000);
    for (let i = 0; i < (failure === "capacity" ? 128 : 0); i++) {
      expect(
        await h.notifications.admit(
          "mention",
          "Mentions",
          {
            sourceKey: `pending-${i}`,
            target: { version: 1, kind: "settings", section: "notifications" },
          },
          () => true,
          () => "wait",
        ),
      ).toBe(true);
    }
    const reportError = h.notifications.reportError;
    const errors = vi.spyOn(h.notifications, "reportError");
    errors.mockImplementation((error) => {
      // Publish the first real error synchronously. Bound a broken implementation
      // at its second report rather than overflowing the runner's stack.
      if (errors.mock.calls.length === 1) reportError(error);
    });
    const originalAdmit = h.notifications.admit.bind(h.notifications);
    const admit = vi.spyOn(h.notifications, "admit");
    if (failure === "observation") {
      admit.mockImplementation((...args) => {
        args[6] = () => {
          throw new Error("Observation failed");
        };
        return originalAdmit(...args);
      });
    }
    const error =
      failure === "capacity"
        ? "Too many pending notifications"
        : "Observation failed";
    const row = h.make("failed admission");
    h.emit([row], "live");
    await h.owner.session.unread.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(new Error(error));
    expect(h.notifications.snapshot().error).toBe(error);
    expect(admit).toHaveBeenCalledTimes(1);
    await expect(admit.mock.results[0]?.value).resolves.toBe(false);
    h.contextQuery.mockClear();
    await h.owner.session.unread.refresh();
    expect(h.contextQuery).not.toHaveBeenCalled();
    expect(h.show).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
  },
);
