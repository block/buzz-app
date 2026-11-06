import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelList, ChannelSummary } from "../relay/contracts";
import type { RelayEvent } from "../relay/events";
import {
  createOwnerAccess,
  type OwnerBinding,
  type OwnerSession,
  ownerMcpEnabled,
} from "./owner-access";

const owner = "a".repeat(64);
const agent = "b".repeat(64);
const person = "c".repeat(64);
const otherOwner = "d".repeat(64);
const relayAuthor = "e".repeat(64);
const community = "https://relay.example.test";
const joined = "11111111-1111-4111-8111-111111111111";
const archived = "22222222-2222-4222-8222-222222222222";
const system = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  vi.unstubAllEnvs();
});

const record = (kind: number, id: string, tags: string[][]) =>
  ({
    id: `${kind}${id}`.padEnd(64, "0").slice(0, 64),
    pubkey: relayAuthor,
    kind,
    created_at: 100,
    content: "",
    tags: [["d", id], ...tags],
    sig: "",
  }) as unknown as RelayEvent;
/** The relay-signed state of channel `id`: owners/admins and the roster. */
function signed(
  id: string,
  roles: Readonly<Record<string, string>>,
  metadata: string[][] = [["t", "stream"], ["private"]],
) {
  return [
    record(39000, id, metadata),
    record(
      39001,
      id,
      Object.entries(roles)
        .filter(([, role]) => role === "owner" || role === "admin")
        .map(([key, role]) => ["p", key, role]),
    ),
    record(
      39002,
      id,
      Object.entries(roles).map(([key, role]) => ["p", key, "", role]),
    ),
  ];
}

/** The owner's session: only reads, so any other member reached fails. */
function fakeSession(
  list: Partial<ChannelList> & { channels: ChannelSummary[] },
  events: () => readonly RelayEvent[] = () => [],
) {
  const touched = new Set<PropertyKey>();
  const readRemote = vi.fn(
    async (_filters: unknown, options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      return events();
    },
  );
  const ensureList = vi.fn();
  const ensure = vi.fn(async () => {});
  const target = {
    relayAuthor,
    channels: {
      list: () => ({ status: "ready", ...list }) as ChannelList,
      // Never in list(), but a lookup can return one.
      get: (id: string): ChannelSummary | undefined =>
        id === system
          ? { id, name: "App data", channelType: "system", members: [owner] }
          : undefined,
      ensureList,
    },
    readRemote,
    names: { resolve: (key: string) => (key === person ? "Pat" : undefined) },
    profiles: {
      ensure,
      snapshot: () => new Map([[owner, { name: "Owner" }]]),
    },
  };
  const session = new Proxy(target, {
    get(object, key, receiver) {
      touched.add(key);
      if (!(key in object)) throw new Error(`Unexpected ${String(key)}`);
      return Reflect.get(object, key, receiver);
    },
  }) as unknown as OwnerSession;
  return { session, readRemote, ensureList, ensure, touched };
}

const channels: ChannelSummary[] = [
  {
    id: joined,
    name: "Plans",
    channelType: "stream",
    private: true,
    viewerRole: "owner",
    members: [owner, person],
    owners: [owner],
  },
  {
    id: archived,
    name: "Old",
    channelType: "forum",
    visibility: "public",
    archived: true,
    members: [owner, person, agent],
  },
];

function bound(session: OwnerSession, viewer = owner) {
  const controller = new AbortController();
  const first: OwnerBinding = {
    viewer,
    origin: community,
    session,
    signal: controller.signal,
  };
  let binding: OwnerBinding | undefined = first;
  return {
    first,
    bind: () => binding,
    controller,
    set(next: OwnerBinding | undefined) {
      binding = next;
    },
  };
}

function started() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ownerMcpEnabled", () => {
  it("is off by default and for every other origin", () => {
    vi.stubEnv("VITE_BUZZ_OWNER_MCP_COMMUNITIES", "");
    expect(ownerMcpEnabled(community)).toBe(false);
    vi.stubEnv("VITE_BUZZ_OWNER_MCP_COMMUNITIES", community);
    expect(ownerMcpEnabled(community)).toBe(true);
    expect(ownerMcpEnabled("wss://relay.example.test")).toBe(true);
    for (const other of [
      "https://other.example.test",
      "https://relay.example.test.evil.test",
      "https://relay.example.test:8443",
      "not a community",
      null,
    ])
      expect(ownerMcpEnabled(other)).toBe(false);
  });
});

describe("owner access", () => {
  it("lists the owner's channels, including ones the agent is not in, as the owner", async () => {
    const fake = fakeSession({ channels });
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channels()).resolves.toEqual({
      execution: { agent, owner, community },
      partial: false,
      channels: [
        {
          id: joined,
          name: "Plans",
          type: "stream",
          visibility: "private",
          archived: false,
          role: "owner",
          members: 2,
        },
        {
          id: archived,
          name: "Old",
          type: "forum",
          visibility: "open",
          archived: true,
          role: "member",
          members: 3,
        },
      ],
    });
    expect(fake.ensureList).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "loading" as const }, true],
    [{ status: "error" as const, error: "offline" }, true],
    [{ coverage: "partial" as const }, false],
  ])("marks a list that is not complete partial: %j", async (state, asks) => {
    const fake = fakeSession({ channels: [], ...state });
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    const list = await access.channels();
    expect(list).toMatchObject({ partial: true, channels: [] });
    if ("error" in state) expect(list.error).toBe("offline");
    expect(fake.ensureList).toHaveBeenCalledTimes(asks ? 1 : 0);
  });

  it("answers a channel with the relay's current roles and rights", async () => {
    // The listed role is stale: the fresh roster says admin.
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [owner]: "admin", [person]: "member", [agent]: "bot" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    const details = await access.channel(joined);
    expect(details).toMatchObject({
      execution: { agent, owner, community },
      channel: { id: joined, role: "admin", members: 3, visibility: "private" },
      capabilities: { manageRoles: true, removeMembers: true },
    });
    expect(fake.readRemote).toHaveBeenCalledExactlyOnceWith(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong",
        authors: [relayAuthor],
        "#d": [joined],
        limit: 1,
      })),
      expect.objectContaining({ priority: "foreground" }),
    );
  });

  it("gives an owner without a role no rights, whatever the list says", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [person]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channel(joined)).resolves.toMatchObject({
      channel: { role: null },
      capabilities: {
        manageRoles: false,
        removeMembers: false,
        archive: false,
        unarchive: false,
        delete: false,
      },
    });
  });

  it.each([
    ["an unknown channel", "33333333-3333-4333-8333-333333333333", () => []],
    ["a channel the relay withholds", joined, () => []],
    [
      "unverifiable roles",
      joined,
      () => signed(joined, { [owner]: "owner" }).slice(0, 1),
    ],
    ["an ID that is not a channel's", "general", () => []],
    [
      "a system channel",
      system,
      () => signed(system, { [owner]: "owner" }, [["t", "system"]]),
    ],
  ])("fails for %s", async (_what, id, events) => {
    const fake = fakeSession({ channels }, events);
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channel(id)).rejects.toThrow();
    await expect(
      access.members(id, { offset: 0, limit: 10 }),
    ).rejects.toThrow();
  });

  it("reads no roster for a channel outside the owner's channels", async () => {
    const fake = fakeSession({ channels: [] }, () =>
      signed(joined, { [owner]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(
      access.members(joined, { offset: 0, limit: 10 }),
    ).rejects.toThrow("not in your owner's channels");
    expect(fake.readRemote).not.toHaveBeenCalled();
  });

  it("pages the roster with roles and names", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, {
        [owner]: "owner",
        [person]: "guest",
        [agent]: "bot",
        [otherOwner]: "custom",
      }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(
      access.members(joined, { offset: 1, limit: 2 }),
    ).resolves.toEqual({
      execution: { agent, owner, community },
      channel: joined,
      total: 4,
      members: [
        { pubkey: person, role: "guest", name: "Pat" },
        { pubkey: agent, role: "bot" },
      ],
    });
    expect(fake.ensure).toHaveBeenCalledExactlyOnceWith(
      [person, agent],
      "foreground",
    );
    await expect(
      access.members(joined, { offset: 3, limit: 2 }),
    ).resolves.toMatchObject({ members: [{ role: "unknown" }] });
  });

  it("only reads", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [owner]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await access.channels();
    await access.channel(joined);
    await access.members(joined, { offset: 0, limit: 10 });
    expect(
      [...fake.touched].every((key) =>
        ["relayAuthor", "channels", "readRemote", "names", "profiles"].includes(
          String(key),
        ),
      ),
    ).toBe(true);
  });

  it.each(["no binding", "another account's binding", "a replaced binding"])(
    "reads nothing with %s",
    async (state) => {
      const fake = fakeSession({ channels }, () =>
        signed(joined, { [owner]: "owner" }),
      );
      const binding = bound(fake.session);
      if (state === "no binding") binding.set(undefined);
      else if (state === "another account's binding")
        binding.set({ ...binding.first, viewer: otherOwner });
      else binding.controller.abort();
      const access = createOwnerAccess({ pubkey: agent, owner }, binding.bind);
      await expect(access.channels()).rejects.toThrow("not connected");
      await expect(access.channel(joined)).rejects.toThrow("not connected");
      expect(fake.readRemote).not.toHaveBeenCalled();
    },
  );

  it.each(["signs in as someone else", "reconnects", "disconnects"])(
    "returns nothing when the owner's connection %s during the call",
    async (change) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = started();
      const fake = fakeSession({ channels });
      const binding = bound(fake.session);
      fake.readRemote.mockImplementation(async () => {
        reading.resolve();
        await held;
        return signed(joined, { [owner]: "owner" });
      });
      const access = createOwnerAccess({ pubkey: agent, owner }, binding.bind);
      const call = access.channel(joined);
      await reading.promise;
      if (change === "signs in as someone else")
        binding.set({ ...binding.first, viewer: otherOwner });
      else if (change === "reconnects")
        binding.set({
          ...binding.first,
          session: fakeSession({ channels }).session,
        });
      else binding.set(undefined);
      release();
      await expect(call).rejects.toThrow("changed during the call");
    },
  );

  it("returns nothing once the binding is replaced mid-read", async () => {
    const reading = started();
    const fake = fakeSession({ channels });
    const binding = bound(fake.session);
    fake.readRemote.mockImplementation(
      (_filters, options) =>
        new Promise<readonly RelayEvent[]>((_resolve, reject) => {
          reading.resolve();
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          );
        }),
    );
    const access = createOwnerAccess({ pubkey: agent, owner }, binding.bind);
    const call = access.channel(joined);
    await reading.promise;
    binding.controller.abort();
    await expect(call).rejects.toThrow("changed during the call");
  });

  it("stops when its caller cancels, before or during the read", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [owner]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    const before = new AbortController();
    before.abort(new Error("Turn ended"));
    await expect(access.channels(before.signal)).rejects.toThrow("Turn ended");
    const during = new AbortController();
    fake.readRemote.mockImplementationOnce(async () => {
      during.abort(new Error("Turn ended"));
      return signed(joined, { [owner]: "owner" });
    });
    await expect(access.channel(joined, during.signal)).rejects.toThrow(
      "Turn ended",
    );
  });

  it("keeps each owner's reads to that owner's own session", async () => {
    const first = fakeSession({ channels });
    const second = fakeSession({
      channels: [{ id: archived, name: "Theirs", members: [otherOwner] }],
    });
    const mine = bound(first.session);
    const theirs = bound(second.session, otherOwner);
    const a = createOwnerAccess({ pubkey: agent, owner }, mine.bind);
    const b = createOwnerAccess(
      { pubkey: person, owner: otherOwner },
      theirs.bind,
    );
    await a.channels();
    const list = await b.channels();
    expect(list.channels.map(({ name }) => name)).toEqual(["Theirs"]);
    expect(list.execution).toEqual({
      agent: person,
      owner: otherOwner,
      community,
    });
    // The first owner's agent never reads through the second owner's session.
    mine.set(theirs.first);
    await expect(a.channels()).rejects.toThrow("not connected");
  });
});
