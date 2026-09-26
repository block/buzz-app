import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { DiscoveryState } from "./discovery";
import { ReadError } from "./errors";
import type { HeadPersistence, SavedHead, SavedStartup } from "./persistence";
import { bounds, keypair, message, metadata, roster, profile } from "./testing";
import type { RelayEvent } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";

const viewer = keypair(),
  relay = keypair();
const discovery = [
  roster(relay, "alpha", [viewer.pubkey]),
  metadata(relay, "alpha", "Alpha"),
];
const head = (content: string) => [
  message(viewer, "alpha", content, 20),
  bounds(relay, "alpha", "head", { has_more: false, next_cursor: null }),
];
const preferences: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: [],
  muted: [],
  sort: {},
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function disk() {
  let startup: SavedStartup | undefined = {
    discovery: {
      savedAt: Date.now(),
      relayAuthor: relay.pubkey,
      events: discovery,
    },
    preferences: { savedAt: Date.now(), data: preferences },
  };
  let heads: SavedHead[] = [
    {
      channelId: "alpha",
      savedAt: Date.now(),
      events: head("saved"),
      profiles: [],
    },
  ];
  const storage: HeadPersistence = {
    readStartup: vi.fn(async () => structuredClone(startup)),
    writeStartup: vi.fn(async (patch) => {
      startup = { ...startup, ...structuredClone(patch) };
    }),
    read: vi.fn(async () => structuredClone(heads)),
    write: vi.fn(async (value) => {
      heads = [structuredClone(value)];
    }),
    retain: vi.fn(async (ids) => {
      heads = heads.filter((row) => ids.includes(row.channelId));
    }),
    remove: vi.fn(async (id) => {
      heads = heads.filter((row) => row.channelId !== id);
    }),
    clear: vi.fn(async () => {
      startup = undefined;
      heads = [];
    }),
    close: vi.fn(),
  };
  return storage;
}
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(
  storage = disk(),
  cachedOnly = false,
  initialChannelId?: string,
) {
  const membership = deferred<RelayEvent[]>();
  const query = vi.fn(
    async (filters: readonly import("./events").ReadFilter[]) => {
      if (filters.some((f) => f.kinds?.includes(39002)))
        return membership.promise;
      if (filters.some((f) => f.kinds?.includes(39000)))
        return [metadata(relay, "alpha", "Updated Alpha", 1_700_000_001)];
      if (filters.some((f) => f["#h"]?.includes("alpha"))) return head("fresh");
      return [];
    },
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
    },
    { persistence: storage, prepared: true, cachedOnly, initialChannelId },
  );
  owners.push(owner);
  return {
    owner,
    channels: owner.session.channels,
    membership,
    query,
    storage,
  };
}
describe("device-local startup", () => {
  it.each([false, true])(
    "keeps saved names on unchanged confirmation but purges them on omission=%s",
    async (omitted) => {
      const storage = disk();
      const records = await storage.read();
      const record = records[0];
      if (!record) throw new Error("Missing saved head");
      record.profiles = [profile(viewer, { name: "Saved name" })];
      storage.read = async () => structuredClone(records);
      const { owner, channels, membership, query } = setup(storage);
      await owner.restore();
      expect(owner.session.profiles.snapshot().get(viewer.pubkey)?.name).toBe(
        "Saved name",
      );
      const names: (string | undefined)[] = [];
      owner.session.profiles.subscribe(() =>
        names.push(owner.session.profiles.snapshot().get(viewer.pubkey)?.name),
      );
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      membership.resolve(omitted ? [] : discovery);
      await vi.waitFor(() =>
        expect(channels.list().channels.some((c) => c.cached)).toBe(false),
      );
      expect(owner.session.profiles.snapshot().get(viewer.pubkey)?.name).toBe(
        omitted ? undefined : "Saved name",
      );
      if (!omitted) expect(names).not.toContain(undefined);
    },
  );

  it("keeps viewer layout across a real channel revocation without restoring denied content", async () => {
    const storage = disk();
    const participant = keypair();
    const alpha = [
      roster(relay, "alpha", [viewer.pubkey, participant.pubkey]),
      metadata(relay, "alpha", "Alpha", 1_700_000_000, [["t", "dm"]]),
    ];
    const beta = [
      roster(relay, "beta", [viewer.pubkey]),
      metadata(relay, "beta", "Beta"),
    ];
    const layout = { ...preferences, starred: ["beta"] };
    await storage.writeStartup?.({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [...alpha, ...beta],
        profiles: [profile(participant, { name: "Alpha-only participant" })],
      },
      preferences: { savedAt: Date.now(), data: layout },
    });
    const { owner, channels, membership, query } = setup(storage);
    await owner.restore();
    expect(
      owner.session.profiles.snapshot().get(participant.pubkey)?.name,
    ).toBe("Alpha-only participant");
    channels.ensureList();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    membership.resolve([...alpha, ...beta]);
    await vi.waitFor(() =>
      expect(channels.list().channels.every((channel) => !channel.cached)).toBe(
        true,
      ),
    );
    query.mockResolvedValue([
      roster(relay, "beta", [viewer.pubkey]),
      metadata(relay, "beta", "Beta"),
    ]);
    channels.refreshList?.();
    await vi.waitFor(() =>
      expect(channels.list().channels.map((channel) => channel.id)).toEqual([
        "beta",
      ]),
    );
    expect(storage.clear).not.toHaveBeenCalled();
    expect(await storage.read()).toEqual([]);
    expect((await storage.readStartup?.())?.preferences?.data).toEqual(layout);
    expect((await storage.readStartup?.())?.discovery?.profiles).toEqual([]);
    const next = setup(storage, true);
    await next.owner.restore();
    expect(next.owner.session.profiles.snapshot().has(participant.pubkey)).toBe(
      false,
    );
    expect(next.channels.list().channels.map((channel) => channel.id)).toEqual([
      "beta",
    ]);
    expect(next.owner.session.sidebarPreferences.snapshot().data).toEqual(
      layout,
    );
    expect(next.channels.window("alpha").rows).toEqual([]);
  });

  it("reveals the selected head before verifying unrelated history", async () => {
    const storage = disk();
    const saved = await storage.readStartup?.();
    if (!saved?.discovery) throw new Error("Missing saved discovery");
    saved.discovery.events.push(
      roster(relay, "beta", [viewer.pubkey]),
      metadata(relay, "beta", "Beta"),
    );
    await storage.writeStartup?.(saved);
    const alpha = (await storage.read())[0];
    if (!alpha) throw new Error("Missing saved head");
    let examinedBeta = false;
    const beta = {
      ...alpha,
      channelId: "beta",
      get events() {
        examinedBeta = true;
        return [];
      },
    };
    storage.read = async () => [beta, alpha];
    const { owner, channels } = setup(storage, true, "alpha");
    await owner.restore();
    channels.ensure("alpha");
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
    expect(examinedBeta).toBe(false);
    await vi.waitFor(() => expect(examinedBeta).toBe(true));
  });

  it("shows signed saved history before discovery, then promotes identical membership and refreshes only demand", async () => {
    const { owner, channels, membership, query } = setup();
    await owner.restore();
    channels.ensureList();
    channels.ensure("alpha");
    channels.prepare?.("alpha");
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    expect(channels.list().channels[0]).toMatchObject({
      name: "Alpha",
      readOnly: true,
      cached: true,
    });
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
    await expect(
      owner.session.read([{ kinds: [9], "#h": ["alpha"], limit: 1 }]),
    ).rejects.toThrow("Reconnect");
    expect(query).toHaveBeenCalledTimes(1);
    membership.resolve(discovery);
    await vi.waitFor(() =>
      expect(channels.window("alpha").rows[0]?.content).toBe("fresh"),
    );
    expect(channels.list().channels[0]?.cached).toBeUndefined();
    expect(channels.list().channels[0]?.readOnly).toBeUndefined();
    expect(
      query.mock.calls
        .flatMap(([filters]) => filters)
        .filter((f) => f["#h"])
        .every((f) => f["#h"]?.every((id) => id === "alpha")),
    ).toBe(true);
  });
  it("a cache-only owner cannot fetch heads, hover preparation, unread evidence or older pages", async () => {
    const { owner, channels, query } = setup(disk(), true);
    await owner.restore();
    channels.ensureList();
    channels.ensure("alpha");
    channels.prepare?.("alpha");
    channels.refresh?.("alpha");
    channels.loadOlder("alpha");
    await owner.session.unread.ensure();
    expect(query).not.toHaveBeenCalled();
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
  });
  it.each(["absent", "denied"])(
    "fresh %s membership removes saved rows, heads and next-launch discovery",
    async (outcome) => {
      const { owner, channels, membership, query, storage } = setup();
      await owner.restore();
      channels.ensure("alpha");
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      if (outcome === "absent") membership.resolve([]);
      else membership.reject(new ReadError("denied", "Removed"));
      await vi.waitFor(() => expect(channels.list().channels).toEqual([]));
      expect(channels.window("alpha").rows).toEqual([]);
      expect(await storage.read()).toEqual([]);
      const saved = await storage.readStartup?.();
      expect(saved?.discovery?.events ?? []).toEqual([]);
    },
  );
  it("transient discovery failure retains the readable snapshot for deliberate retry", async () => {
    const { owner, channels, membership, query } = setup();
    await owner.restore();
    channels.ensure("alpha");
    channels.ensureList();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    membership.reject(new ReadError("unavailable", "Offline"));
    await vi.waitFor(() => expect(channels.list().status).toBe("error"));
    expect(channels.list().channels[0]?.cached).toBe(true);
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
  });
  it.each(["tampered", "expired", "other-relay"])(
    "ignores %s discovery without blocking fresh reads",
    async (mode) => {
      const storage = disk();
      const saved = await storage.readStartup?.();
      if (!saved?.discovery) throw new Error("Missing saved discovery");
      if (mode === "tampered")
        saved.discovery.events[0] = { ...discovery[0], content: "tampered" };
      if (mode === "expired") saved.discovery.savedAt -= 86_400_001;
      if (mode === "other-relay")
        saved.discovery.relayAuthor = keypair().pubkey;
      await storage.writeStartup?.(saved);
      const { owner, channels, membership, query } = setup(storage);
      await owner.restore();
      expect(channels.list().channels).toEqual([]);
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      membership.resolve(discovery);
      await vi.waitFor(() =>
        expect(channels.list().channels[0]?.name).toBe("Alpha"),
      );
    },
  );
  it("fresh authority wins over a late disk read", async () => {
    const storage = disk();
    const saved = await storage.readStartup?.();
    const delayed = deferred<SavedStartup | undefined>();
    storage.readStartup = () => delayed.promise;
    const { owner, channels } = setup(storage);
    const restoring = owner.restore();
    await owner.session.read([{ kinds: [39000], "#d": ["alpha"], limit: 1 }]);
    delayed.resolve(saved);
    await restoring;
    expect(channels.list().channels).toEqual([]);
  });
  it("clear cache fences a pending restore and prevents saved roster resurrection", async () => {
    const storage = disk();
    const saved = await storage.readStartup?.();
    const delayed = deferred<SavedStartup | undefined>();
    storage.readStartup = () => delayed.promise;
    const { owner, channels } = setup(storage, true);
    const restoring = owner.restore();
    await owner.clearCache();
    delayed.resolve(saved);
    await restoring;
    channels.ensure("alpha");
    await owner.restore();
    expect(channels.list().channels).toEqual([]);
    expect(channels.window("alpha").rows).toEqual([]);
    expect(await storage.read()).toEqual([]);
  });
  it("clearing an already restored owner removes its cached discovery", async () => {
    const { owner, channels } = setup(disk(), true);
    await owner.restore();
    channels.ensure("alpha");
    await owner.clearCache();
    channels.ensure("alpha");
    expect(channels.list().channels).toEqual([]);
    expect(channels.window("alpha").rows).toEqual([]);
  });
  it("never renews unconfirmed saved membership or promotes it from an older response", () => {
    const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
    state.accept(roster(relay, "alpha", [viewer.pubkey], 20), true);
    state.accept(roster(relay, "beta", [viewer.pubkey], 20));
    state.accept(roster(relay, "alpha", [viewer.pubkey], 19));
    expect(state.canParticipate("alpha")).toBe(false);
    expect(
      state
        .savedEvents()
        .map((event) => event.tags.find(([key]) => key === "d")?.[1]),
    ).toEqual(["beta"]);
  });
  it("restores preference display without a writable base; fresh response replaces it", async () => {
    const fresh = deferred<typeof preferences>();
    const sort = vi.fn(),
      mute = vi.fn();
    const store = createSidebarPreferencesStore(
      () => fresh.promise,
      true,
      undefined,
      undefined,
      undefined,
      mute,
      sort,
      disk(),
    );
    try {
      await store.ready;
      expect(store.queries.snapshot()).toMatchObject({
        cached: true,
        data: { sections: preferences.sections },
      });
      expect(store.queries.writable).toBe(false);
      expect(store.queries.sortWritable).toBe(false);
      await expect(
        store.queries.setSort("channels", "recent", ["alpha"]),
      ).rejects.toThrow();
      await expect(store.queries.setMute("alpha", true)).rejects.toThrow();
      expect(sort).not.toHaveBeenCalled();
      expect(mute).not.toHaveBeenCalled();
      const loading = store.queries.ensure();
      fresh.resolve({ ...preferences, sections: [], assignments: {} });
      await loading;
      expect(store.queries.snapshot().cached).toBeUndefined();
      expect(store.queries.snapshot().data?.sections).toEqual([]);
    } finally {
      store.dispose();
    }
  });
});
