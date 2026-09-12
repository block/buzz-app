import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
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
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "../relay/read-state-storage";
import { NotificationsService } from "./service";
import { createNotificationPreferences } from "./preferences";
import { provideNavigation } from "../navigation/service";
import { bindMessageNotifications, notificationAuthorized } from "./messages";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
});
async function setup(
  readBarrier: Promise<void> = Promise.resolve(),
  readFrontier?: number,
) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  const origin = "https://relay.example.com";
  let callbacks!: LiveCallbacks;
  let readState: ReadJournal | undefined =
    readFrontier === undefined
      ? undefined
      : {
          ...newReadJournal(),
          state: { frontiers: { room: readFrontier }, overrides: {} },
        };
  const query = vi.fn(async () => [] as ReturnType<typeof message>[]);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      subscribe(value) {
        callbacks = value;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateStorage: {
        async update(change) {
          await readBarrier;
          readState = readJournal(change(readState), viewer.pubkey);
          return readState;
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
  const stop = bindMessageNotifications(notifications, communities);
  cleanups.push(stop);
  await flush();
  notifications.updatePreferences({ sound: false });
  const emit = (
    events: ReturnType<typeof message>[],
    phase?: "replay" | "live",
    channelId = "room",
  ) => callbacks.receive(events, phase ? { phase, channelId } : undefined);
  emit([
    roster(relay, "room", [viewer.pubkey]),
    metadata(relay, "room", "Room"),
  ]);
  const make = (text: string, age = 0, author = peer) =>
    message(author, "room", text, Math.floor(Date.now() / 1000) - age, [
      ["p", viewer.pubkey],
    ]);
  return {
    owner,
    notifications,
    navigation,
    emit,
    make,
    show,
    permission,
    query,
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
it("only production live traffic can create a message notification, never history/replay/local observation", async () => {
  const h = await setup();
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
  h.click();
  expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
    messageId: fresh.id,
  });
  expect(h.owner.session.unread.attention("room", fresh.id).unread).toBe(true);
});
it("viewing suppression uses the shared lease, and suppressed candidates never become delayed alerts", async () => {
  const h = await setup();
  const row = h.make("visible");
  const lease = h.owner.session.unread.reading("room");
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["room"], limit: 50 },
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
  const visible = h.owner.session.unread.reading("room");
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
    expect(h.owner.session.unread.sync().status).toBe("local");
    expect(h.owner.session.unread.attention("room", row.id)).toMatchObject({
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
        h.emit([roster(h.relay, "room", [], Math.floor(now / 1000))]);
      if (condition === "muted")
        h.notifications.updatePreferences({ enabled: false });
      if (condition === "switched") h.deselect();
      if (condition === "viewed") {
        const lease = h.owner.session.unread.reading("room");
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
  h.emit([roster(h.relay, "room", [], now + 1)]);
  h.emit([roster(h.relay, "room", [h.viewer.pubkey], now + 2)]);
  h.query.mockResolvedValueOnce([row]);
  await h.owner.session.read([{ ids: [row.id], limit: 1 }]);
  expect(h.owner.session.unread.attention("room", row.id)).toMatchObject({
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
  expect(h.query).not.toHaveBeenCalled();
});

it.each(["direct", "thread"] as const)(
  "live %s messages carry the correct title and preview",
  async (category) => {
    const h = await setup();
    h.emit([profile(h.peer, { name: "Pinky" })]);
    const now = Math.floor(Date.now() / 1000);
    const root = message(h.viewer, "room", "Own thread", now - 1);
    if (category === "direct") {
      h.emit([
        signed(h.relay, {
          kind: 39000,
          content: JSON.stringify({
            name: "internal-dm-id",
            channel_type: "dm",
          }),
          tags: [
            ["d", "room"],
            ["name", "internal-dm-id"],
            ["t", "dm"],
          ],
          created_at: now,
        }),
      ]);
    } else h.emit([root], "replay");
    const row = message(
      h.peer,
      "room",
      "A **new** reply",
      now,
      category === "thread" ? [["e", root.id, "", "reply"]] : [],
    );
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
