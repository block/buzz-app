import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, message, metadata, roster } from "./testing";
import {
  sidebarFixture,
  sidebarRow,
  sidebarAccount,
  deferredSidebar,
} from "./sidebar-testing";
import type { LiveCallbacks } from "./live";
import type { SidebarPage } from "./sidebar-api";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
});
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    bff = sidebarFixture();
  let live!: LiveCallbacks;
  const sort: Record<string, "recent"> = {};
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      sidebarApi: bff.api,
      query: async () => [],
      media: () => undefined,
      decodeSidebarPreferences: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
        sort: {},
      }),
      writeSidebarSort: async (group, mode) => {
        if (mode === "recent") sort[group] = mode;
        else delete sort[group];
        return { ...sort };
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { sidebarStorage: bff.storage },
  );
  cleanups.push(owner.dispose);
  live.receive([
    roster(relay, channel, [viewer.pubkey]),
    metadata(relay, channel, "Room"),
  ]);
  const row = (at: number) =>
    sidebarRow(channel, {
      latest_message_id: "a".repeat(64),
      latest_message_at: at,
    });
  return {
    ...owner,
    bff,
    live,
    relay,
    viewer,
    row,
    latest: () =>
      owner.session.channels.list().channels.find((c) => c.id === channel)
        ?.lastActivityAt,
  };
}
it("uses the shared sidebar response for Recent, with no sort-owned reads or live count reconstruction", async () => {
  const h = setup();
  h.bff.rows.set(channel, h.row(50));
  await h.session.unread.ensure();
  expect(h.latest()).toBe(50);
  expect(h.session.channels.list().activityStatus).toBe("ready");
  await h.session.sidebarPreferences.ensure();
  await h.session.sidebarPreferences.setSort("channels", "recent", []);
  await h.session.sidebarPreferences.setSort("dms", "recent", []);
  expect(h.bff.api.sidebar).toHaveBeenCalledOnce();
  h.live.receive([message(keypair(), channel, "live", 90)]);
  expect(h.latest()).toBe(50);
  h.bff.rows.set(channel, h.row(90));
  await h.session.unread.refresh();
  expect(h.latest()).toBe(90);
  const snapshot = h.session.channels.list();
  expect(h.session.channels.list()).toBe(snapshot);
});
it("keeps last server activity on failure, exposes error and recovers by explicit refresh", async () => {
  const h = setup();
  h.bff.rows.set(channel, h.row(50));
  await h.session.unread.ensure();
  h.bff.api.sidebar.mockRejectedValueOnce(new Error("offline"));
  await h.session.unread.refresh();
  expect(h.latest()).toBe(50);
  expect(h.session.channels.list().activityStatus).toBe("error");
  h.bff.rows.set(channel, h.row(100));
  await h.session.unread.refresh();
  expect(h.latest()).toBe(100);
  expect(h.session.channels.list().activityStatus).toBe("ready");
});
it.each(["clear", "dispose", "revoke"])(
  "%s fences late sidebar activity",
  async (cause) => {
    const h = setup();
    const held = deferredSidebar<SidebarPage>();
    h.bff.api.sidebar.mockImplementationOnce(() => held.promise);
    const reading = h.session.unread.ensure();
    await vi.waitFor(() => expect(h.bff.api.sidebar).toHaveBeenCalledOnce());
    if (cause === "clear") await h.clearCache();
    if (cause === "dispose") h.dispose();
    if (cause === "revoke")
      h.live.receive([roster(h.relay, channel, [], 1_800_000_000)]);
    held.resolve({
      account: sidebarAccount,
      channels: [h.row(200)],
      next_cursor: null,
    });
    await reading;
    expect(h.latest()).toBeUndefined();
  },
);
it("a stale sidebar row never rolls back newer live activity", async () => {
  const h = setup();
  h.bff.rows.set(channel, h.row(50));
  await h.session.unread.ensure();
  expect(h.latest()).toBe(50);
  const held = deferredSidebar<SidebarPage>();
  h.bff.api.sidebar.mockImplementationOnce(() => held.promise);
  const refreshing = h.session.unread.refresh();
  await vi.waitFor(() => expect(h.bff.api.sidebar).toHaveBeenCalledTimes(2));
  h.live.receive([message(keypair(), channel, "live", 90)], {
    phase: "live",
    channelId: channel,
  });
  expect(h.latest()).toBe(90);
  held.resolve({
    account: sidebarAccount,
    channels: [h.row(60)],
    next_cursor: null,
  });
  await refreshing;
  expect(h.latest()).toBe(90);
  h.bff.rows.set(channel, h.row(120));
  await h.session.unread.refresh();
  expect(h.latest()).toBe(120);
});
