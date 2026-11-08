import { afterEach, expect, it, vi } from "vitest";
import { appClient } from "../../buzz-mcp/app-client";
import type { OwnerMutationCaller } from "../../buzz-mcp/client";
import { callSessionTool } from "../../buzz-mcp/session-tools";
import type { RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import {
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "../relay/outbox";
import { matchesEvent } from "../relay/projection";
import { createRelaySession } from "../relay/session";
import { keypair, signed } from "../relay/testing";
import { SOLO_LABEL } from "../solo/labels";
import { createOwnerAccess, type OwnerBinding } from "./owner-access";
import type { AgentHandle } from "./service";

const community = "https://relay.example.test";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The owner's real session against a relay that applies signed member
 * commands to its roster and accepts an agent's message only from a member. */
function setup(
  type: "stream" | "solo" | "system" | "dm" = "stream",
  storage?: OutboxStorage,
) {
  const owner = keypair(),
    relay = keypair(),
    agent = keypair(),
    other = keypair(),
    person = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const roles = new Map<string, string>([[owner.pubkey, "owner"]]);
  const profiles = new Map<string, Record<string, unknown>>([
    [person.pubkey, { name: "Pat" }],
    [agent.pubkey, { name: "Helper", is_agent: true }],
    [other.pubkey, { name: "Other", is_agent: true }],
  ]);
  let clock = 1_700_000_000;
  let archived = false;
  /** The next publish fails this way, after applying when `applied`. */
  let fail: { error: Error; applied: boolean } | undefined;
  let signing: { entered(): void; held: Promise<void> } | undefined;
  const published: RelayEvent[] = [];
  let live!: LiveCallbacks;
  const accept = vi.fn(async (event: RelayEvent) => {
    const failure = fail;
    fail = undefined;
    if (failure && !failure.applied) throw failure.error;
    const target = event.tags.find(([tag]) => tag === "p")?.[1] ?? "";
    if (event.pubkey === owner.pubkey && event.kind === 9000)
      roles.set(
        target,
        event.tags.find(([tag]) => tag === "role")?.[1] ?? "member",
      );
    else if (event.pubkey === owner.pubkey && event.kind === 9001)
      roles.delete(target);
    else if (event.kind === 9) {
      const role = roles.get(event.pubkey);
      if (!role || role === "guest")
        throw new PublishRejected("restricted: not a member of this channel");
    }
    clock++;
    published.push(event);
    if (failure) throw failure.error;
  });
  const sign = async (template: Parameters<typeof signed>[1]) => {
    const gate = signing;
    signing = undefined;
    if (gate) {
      gate.entered();
      await gate.held;
    }
    return signed(owner, template);
  };
  const readQuery = async (
    filters: readonly import("../relay/events").ReadFilter[],
  ) => {
    const tags = [
      ["d", id],
      ["t", type === "solo" ? "stream" : type],
      ...(type === "solo" ? [["t", SOLO_LABEL]] : []),
      ["private"],
      ["name", "Plans"],
      ...(archived ? [["archived", "true"]] : []),
    ];
    const entries = [...roles];
    const events = [
      signed(relay, { kind: 39000, content: "", created_at: clock, tags }),
      signed(relay, {
        kind: 39001,
        content: "",
        created_at: clock,
        tags: [
          ["d", id],
          ...entries
            .filter(([, role]) => role === "owner" || role === "admin")
            .map(([key, role]) => ["p", key, role]),
        ],
      }),
      signed(relay, {
        kind: 39002,
        content: "",
        created_at: clock,
        tags: [
          ["d", id],
          ...entries.map(([key, role]) => ["p", key, "", role]),
        ],
      }),
      ...[...profiles].map(([key, body]) =>
        signed(
          key === person.pubkey ? person : key === agent.pubkey ? agent : other,
          { kind: 0, content: JSON.stringify(body), tags: [] },
        ),
      ),
    ];
    return events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
  };
  const query = vi.fn(readQuery);
  const owned = createRelaySession(
    {
      viewer: owner.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: [{ pubkey: agent.pubkey, name: "Helper" }],
      }),
      memberAdministration: { sign, publish: accept },
      writer: { kinds: [9, 9000, 9007], sign, publish: accept },
      query,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: storage ?? { load: () => [], save: () => {} } },
  );
  cleanups.push(() => owned.dispose());
  const session = owned.session;
  let binding: OwnerBinding = {
    viewer: owner.pubkey,
    origin: community,
    session,
    signal: new AbortController().signal,
  };
  const lifetime = new AbortController();
  const access = createOwnerAccess(
    { pubkey: agent.pubkey, owner: owner.pubkey },
    () => binding,
    lifetime.signal,
  );
  let ended = false;
  const turn = new AbortController();
  const caller: OwnerMutationCaller = {
    signal: turn.signal,
    check: () => {
      if (ended) throw new Error("The turn has ended");
    },
  };
  const client = appClient(
    {
      pubkey: agent.pubkey,
      key: agent.pubkey,
      owner: owner.pubkey,
      ownerAccess: access,
    } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
      signal: turn.signal,
      check: caller.check,
    },
  );
  return {
    id,
    owner,
    agent,
    other,
    person,
    roles,
    profiles,
    query,
    published,
    receive: accept,
    echo: (event: RelayEvent) => live.receive([event]),
    async archive() {
      archived = true;
      clock++;
      live.receive(await readQuery([{ kinds: [39000], "#d": [id], limit: 1 }]));
    },
    session,
    access,
    caller,
    lifetime,
    end: () => {
      ended = true;
    },
    rebind: (next: Partial<OwnerBinding>) => {
      binding = { ...binding, ...next };
    },
    /** A tool call as the agent's harness makes it, answer and all. */
    call: async (name: string, args: Record<string, unknown>) =>
      JSON.parse(String(await callSessionTool(client, {}, name, args))),
    /** The agent's own message to the channel, as the relay judges it. */
    say: (content: string) =>
      accept(signed(agent, { kind: 9, content, tags: [["h", id]] })),
    failNext: (error: Error, applied = false) => {
      fail = { error, applied };
    },
    holdSigning: () => {
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      signing = { entered, held };
      return { release, started };
    },
    async ready() {
      session.channels.ensureList();
      await vi.waitFor(() =>
        expect(session.channels.list().status).toBe("ready"),
      );
      await session.agentChoices.refresh();
    },
  };
}

const commands = (t: ReturnType<typeof setup>) =>
  t.published.filter((event) => event.pubkey === t.owner.pubkey);

it("adds a library agent the owner's way, after which its ordinary message is accepted, and removal revokes it", async () => {
  const t = setup();
  await t.ready();
  await expect(t.say("before")).rejects.toThrow("not a member");
  const added = await t.call("owner_member_add", {
    channel: t.id,
    pubkey: t.agent.pubkey,
  });
  expect(added).toMatchObject({
    executedAs: { agent: t.agent.pubkey, owner: t.owner.pubkey, community },
    status: "confirmed",
    target: "agent",
    role: "member",
    operation: commands(t)[0]?.id,
  });
  expect(commands(t)).toHaveLength(1);
  expect(commands(t)[0]).toMatchObject({ kind: 9000 });
  expect(t.roles.get(t.agent.pubkey)).toBe("member");
  await t.say("hello from the agent");
  expect(t.published.at(-1)).toMatchObject({
    pubkey: t.agent.pubkey,
    kind: 9,
  });
  // Repeating it changes nothing.
  expect(
    await t.call("owner_member_add", { channel: t.id, pubkey: t.agent.pubkey }),
  ).toMatchObject({ status: "confirmed", role: "member" });
  expect(commands(t)).toHaveLength(1);

  const removed = await t.call("owner_member_remove", {
    channel: t.id,
    pubkey: t.agent.pubkey,
    expected_role: "member",
  });
  expect(removed).toMatchObject({
    status: "confirmed",
    role: null,
    operation: commands(t)[1]?.id,
  });
  expect(commands(t)[1]).toMatchObject({ kind: 9001 });
  await expect(t.say("after")).rejects.toThrow("not a member");
});

it("adds a person, as a guest when asked, and changes their role to the one the roster confirms", async () => {
  const t = setup();
  await t.ready();
  expect(
    await t.call("owner_member_add", {
      channel: t.id,
      pubkey: t.person.pubkey,
      role: "guest",
    }),
  ).toMatchObject({ status: "confirmed", target: "person", role: "guest" });
  expect(commands(t)[0]?.tags).toContainEqual(["role", "guest"]);
  const promoted = await t.call("owner_member_set_role", {
    channel: t.id,
    pubkey: t.person.pubkey,
    role: "admin",
    expected_role: "guest",
  });
  expect(promoted).toMatchObject({
    status: "confirmed",
    role: "admin",
    operation: commands(t)[1]?.id,
  });
  expect(commands(t)[1]?.tags).toContainEqual(["role", "admin"]);
  // A stale expected role is refused with the actual one.
  expect(
    await t.call("owner_member_set_role", {
      channel: t.id,
      pubkey: t.person.pubkey,
      role: "member",
      expected_role: "guest",
    }),
  ).toMatchObject({ status: "rejected", role: "admin" });
  expect(commands(t)).toHaveLength(2);
});

it.each([
  ["someone with no profile", "unknown", "Could not confirm"],
  [
    "an agent outside the owner's library",
    "other",
    "not in your owner's agent library",
  ],
] as const)("adds nothing for %s", async (_, who, reason) => {
  const t = setup();
  await t.ready();
  const target = who === "other" ? t.other.pubkey : keypair().pubkey;
  expect(
    await t.call("owner_member_add", { channel: t.id, pubkey: target }),
  ).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining(reason),
  });
  expect(t.published).toHaveLength(0);
});

it("refuses role changes that would make an agent an admin or touch the caller or owner", async () => {
  const t = setup();
  await t.ready();
  await t.call("owner_member_add", { channel: t.id, pubkey: t.agent.pubkey });
  t.roles.set(t.other.pubkey, "member");
  const role = (pubkey: string, expected_role: string) =>
    t.call("owner_member_set_role", {
      channel: t.id,
      pubkey,
      role: "admin",
      expected_role,
    });
  expect(await role(t.agent.pubkey, "member")).toMatchObject({
    status: "rejected",
    reason: "You cannot change your own role.",
  });
  expect(await role(t.other.pubkey, "member")).toMatchObject({
    status: "rejected",
    reason: "Agents cannot be made admins.",
  });
  expect(await role(t.owner.pubkey, "admin")).toMatchObject({
    status: "rejected",
  });
  // A person whose profile can't be read is not proven to be one.
  const stranger = keypair().pubkey;
  t.roles.set(stranger, "member");
  expect(await role(stranger, "member")).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("could not be confirmed as a person"),
  });
  expect(commands(t)).toHaveLength(1);
});

it("removes from a Solo chat but changes no roles there", async () => {
  const t = setup("solo");
  await t.ready();
  t.roles.set(t.person.pubkey, "member");
  expect(
    await t.call("owner_member_set_role", {
      channel: t.id,
      pubkey: t.person.pubkey,
      role: "guest",
      expected_role: "member",
    }),
  ).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("Solo"),
  });
  expect(
    await t.call("owner_member_remove", {
      channel: t.id,
      pubkey: t.person.pubkey,
    }),
  ).toMatchObject({ status: "confirmed", role: null });
  expect(
    await t.call("owner_member_add", {
      channel: t.id,
      pubkey: t.person.pubkey,
      role: "guest",
    }),
  ).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("Solo"),
  });
  expect(commands(t).map(({ kind }) => kind)).toEqual([9001]);
});

it("changes nothing in a system channel", async () => {
  const t = setup("system");
  await t.ready();
  for (const [name, args] of [
    ["owner_member_add", { pubkey: t.person.pubkey }],
    ["owner_member_remove", { pubkey: t.person.pubkey }],
  ] as const)
    await expect(t.call(name, { channel: t.id, ...args })).rejects.toThrow(
      "not in your owner's channels",
    );
  expect(t.published).toHaveLength(0);
});

it("changes no DM's members", async () => {
  const t = setup("dm");
  await t.ready();
  t.roles.set(t.person.pubkey, "member");
  for (const [name, args] of [
    ["owner_member_add", { pubkey: t.agent.pubkey }],
    ["owner_member_remove", { pubkey: t.person.pubkey }],
    [
      "owner_member_set_role",
      { pubkey: t.person.pubkey, role: "guest", expected_role: "member" },
    ],
  ] as const)
    expect(await t.call(name, { channel: t.id, ...args })).toMatchObject({
      status: "rejected",
      reason: "Members of a DM cannot be changed.",
    });
  expect(t.published).toHaveLength(0);
});

it.each(["person", "agent"] as const)(
  "rejects a definitive relay refusal of a %s addition with its signed operation ID",
  async (target) => {
    const t = setup();
    await t.ready();
    const pubkey = t[target].pubkey;
    t.failNext(new PublishRejected("restricted: member addition refused"));
    const added = await t.call("owner_member_add", { channel: t.id, pubkey });
    const receipt = t.session.outbox?.snapshot()[0];
    expect(receipt).toMatchObject({
      signed: { id: added.operation },
      delivery: "failed",
      refused: true,
    });
    expect(added.operation).toMatch(/^[0-9a-f]{64}$/);
    expect(added).toMatchObject({
      status: "rejected",
      target,
      operation: receipt?.event.id,
    });
    expect(t.roles.has(pubkey)).toBe(false);
    expect(commands(t)).toHaveLength(0);
  },
);

it("keeps a person addition unconfirmed if its failed receipt disappears during roster readback", async () => {
  const t = setup();
  await t.ready();
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing relay fixture");
  let operation: string | undefined;
  t.query.mockImplementation(async (filters) => {
    const receipt = t.session.outbox
      ?.snapshot()
      .find((item) => item.delivery === "failed");
    if (receipt) {
      operation = receipt.event.id;
      await t.session.outbox?.dismiss(operation);
    }
    return query(filters);
  });
  t.failNext(new PublishRejected("restricted: member addition refused"));
  const added = await t.call("owner_member_add", {
    channel: t.id,
    pubkey: t.person.pubkey,
  });
  expect(operation).toMatch(/^[0-9a-f]{64}$/);
  expect(t.session.outbox?.snapshot()).toEqual([]);
  expect(added).toMatchObject({
    status: "unconfirmed",
    target: "person",
    operation,
  });
  expect(t.roles.has(t.person.pubkey)).toBe(false);
});

it("resumes a possibly-sent addition from a repeated call instead of sending another", async () => {
  const t = setup();
  await t.ready();
  t.failNext(new Error("Receipt lost"));
  const first = await t.call("owner_member_add", {
    channel: t.id,
    pubkey: t.person.pubkey,
  });
  expect(first).toMatchObject({ status: "unconfirmed", target: "person" });
  expect(first.operation).toMatch(/^[0-9a-f]{64}$/);
  expect(t.roles.has(t.person.pubkey)).toBe(false);
  const again = await t.call("owner_member_add", {
    channel: t.id,
    pubkey: t.person.pubkey,
  });
  expect(again).toMatchObject({
    status: "confirmed",
    role: "member",
    operation: first.operation,
    existing: true,
  });
  expect(commands(t).map(({ id }) => id)).toEqual([first.operation]);
});

it("confirms an addition the relay applied even when its receipt was lost", async () => {
  const t = setup();
  await t.ready();
  t.failNext(new Error("Receipt lost"), true);
  const added = await t.call("owner_member_add", {
    channel: t.id,
    pubkey: t.person.pubkey,
  });
  expect(added).toMatchObject({
    status: "confirmed",
    target: "person",
    role: "member",
    operation: commands(t)[0]?.id,
  });
  expect(commands(t)).toHaveLength(1);
});

it("publishes nothing when the call ends while the change is being signed", async () => {
  for (const name of [
    "owner_member_add",
    "agent",
    "owner_member_set_role",
    "owner_member_remove",
  ] as const) {
    const t = setup();
    await t.ready();
    if (name === "owner_member_set_role" || name === "owner_member_remove")
      t.roles.set(t.person.pubkey, "member");
    const held = t.holdSigning();
    const pending = t.call(name === "agent" ? "owner_member_add" : name, {
      channel: t.id,
      pubkey: name === "agent" ? t.agent.pubkey : t.person.pubkey,
      ...(name === "owner_member_set_role"
        ? { role: "guest", expected_role: "member" }
        : {}),
    });
    await held.started;
    t.end();
    held.release();
    await pending.then(
      (result) => expect(result.status).not.toBe("confirmed"),
      (error) => expect(String(error)).toMatch(/call ended|cancelled/),
    );
    expect(t.published).toHaveLength(0);
  }
});

it.each(["agent", "person"] as const)(
  "publishes nothing when a %s addition's channel is archived during signing",
  async (target) => {
    const t = setup();
    await t.ready();
    const held = t.holdSigning();
    const pending = t.call("owner_member_add", {
      channel: t.id,
      pubkey: t[target].pubkey,
    });
    try {
      await held.started;
      await t.archive();
      await vi.waitFor(() =>
        expect(t.session.channels.list().channels).toContainEqual(
          expect.objectContaining({ id: t.id, archived: true }),
        ),
      );
    } finally {
      held.release();
    }
    await expect(pending).resolves.toMatchObject({
      status: expect.not.stringMatching(/^confirmed$/),
    });
    expect(commands(t)).toHaveLength(0);
    expect(t.roles.has(t[target].pubkey)).toBe(false);
  },
);

it("publishes nothing once the owner's binding or the agent's run changes mid-change", async () => {
  for (const change of ["binding", "lifetime"] as const) {
    const t = setup();
    await t.ready();
    t.roles.set(t.person.pubkey, "member");
    const held = t.holdSigning();
    const pending = t.access.setMemberRole(
      {
        channel: t.id,
        pubkey: t.person.pubkey,
        role: "guest",
        expectedRole: "member",
      },
      t.caller,
    );
    await held.started;
    if (change === "binding") t.rebind({ viewer: t.person.pubkey });
    else t.lifetime.abort();
    held.release();
    await expect(pending).resolves.toMatchObject({
      status: expect.not.stringMatching(/^confirmed$/),
    });
    expect(t.published).toHaveLength(0);
    expect(t.roles.get(t.person.pubkey)).toBe("member");
  }
});

it("changes nothing for a host that gives no caller check", async () => {
  const t = setup();
  await t.ready();
  await expect(
    t.access.addMember({ channel: t.id, pubkey: t.person.pubkey }),
  ).rejects.toThrow("nothing was changed");
  expect(t.published).toHaveLength(0);
});

it("refuses to remove someone while their addition is still sending, listed or not", async () => {
  for (const listed of [true, false]) {
    const t = setup();
    await t.ready();
    const held = t.holdSigning();
    const adding = t.access.addMember(
      { channel: t.id, pubkey: t.person.pubkey },
      t.caller,
    );
    await held.started;
    if (listed) t.roles.set(t.person.pubkey, "member");
    expect(
      await t.access.removeMember(
        { channel: t.id, pubkey: t.person.pubkey },
        t.caller,
      ),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("still sending"),
    });
    held.release();
    await adding;
    expect(commands(t).map(({ kind }) => kind)).toEqual([9000]);
  }
});

it.each([false, true])(
  "does not confirm removal before a restored unknown addition settles (batch: %s)",
  async (batch) => {
    let restore!: (items: readonly OutgoingEvent[]) => void;
    const loaded = new Promise<readonly OutgoingEvent[]>((resolve) => {
      restore = resolve;
    });
    const t = setup("stream", { load: () => loaded, save: () => {} });
    await t.ready();
    const event = signed(t.owner, {
      kind: 9000,
      content: "",
      tags: [
        ["h", t.id],
        ["p", t.person.pubkey],
      ],
    });
    const receipt: OutgoingEvent = {
      event,
      signed: event,
      delivery: "unknown",
      ...(batch
        ? { recovery: { key: `member-add:batch:${t.id}`, value: "1" } }
        : {}),
    };
    restore([receipt]);
    await t.session.outbox?.ready();
    expect(
      await t.access.removeMember(
        { channel: t.id, pubkey: t.person.pubkey },
        t.caller,
      ),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("unresolved"),
    });
    expect(commands(t)).toHaveLength(0);
    // The original publication may arrive after the absent-roster read.
    await t.receive(event);
    t.echo(event);
    expect(t.roles.get(t.person.pubkey)).toBe("member");
    await t.session.memberAdditions.add(t.id, t.person.pubkey);
    expect(
      await t.access.removeMember(
        { channel: t.id, pubkey: t.person.pubkey },
        t.caller,
      ),
    ).toMatchObject({ status: "confirmed", role: null });
    expect(commands(t).map(({ kind }) => kind)).toEqual([9000, 9001]);
  },
);

it.each([false, true])(
  "keeps an unknown batch fenced through fallback additions (fallback accepted: %s)",
  async (accepted) => {
    let restore!: (items: readonly OutgoingEvent[]) => void;
    const loaded = new Promise<readonly OutgoingEvent[]>((resolve) => {
      restore = resolve;
    });
    const t = setup("stream", { load: () => loaded, save: () => {} });
    await t.ready();
    const second = keypair();
    const batch = signed(t.owner, {
      kind: 9000,
      content: "",
      tags: [
        ["h", t.id],
        ["p", t.person.pubkey],
        ["p", second.pubkey],
        ["role", "member"],
      ],
    });
    const single = signed(t.owner, {
      kind: 9000,
      content: "",
      tags: [
        ["h", t.id],
        ["p", second.pubkey],
        ["role", "member"],
      ],
    });
    restore([
      {
        event: batch,
        signed: batch,
        delivery: "unknown",
        recovery: { key: `member-add:batch:${t.id}`, value: "1" },
      },
      {
        event: single,
        signed: single,
        delivery: "failed",
        recovery: { key: `member-add:${t.id}:${second.pubkey}`, value: "1" },
      },
    ]);
    await t.session.outbox?.ready();
    if (!accepted) t.failNext(new PublishRejected("restricted: cannot add"));
    const [fallback] = await Promise.allSettled([
      t.session.memberAdditions.add(t.id, t.person.pubkey),
    ]);
    expect(fallback?.status).toBe(accepted ? "fulfilled" : "rejected");
    const removed = await t.access.removeMember(
      { channel: t.id, pubkey: t.person.pubkey },
      t.caller,
    );
    // A lost receipt can precede the original command reaching an older relay
    // that applies only the first recipient. Fallback coverage cannot retire it.
    await t.receive(batch);
    expect(t.roles.get(t.person.pubkey)).toBe("member");
    expect(removed).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("unresolved"),
    });
    expect(t.session.outbox?.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: batch, delivery: "unknown" }),
      ]),
    );
    // Exact original delivery evidence, unlike another invitation's outcome,
    // lets ordinary settlement complete without replaying the old batch.
    t.echo(batch);
    await t.session.memberAdditions.add(t.id, t.person.pubkey);
    expect(
      t.session.outbox?.snapshot().some((item) => item.event.id === batch.id),
    ).toBe(false);
    expect(
      await t.access.removeMember(
        { channel: t.id, pubkey: t.person.pubkey },
        t.caller,
      ),
    ).toMatchObject({ status: "confirmed", role: null });
    expect(t.roles.has(t.person.pubkey)).toBe(false);
    expect(commands(t).filter((event) => event.id === batch.id)).toHaveLength(
      1,
    );
  },
);

it.each([false, true])(
  "fences role changes behind a restored explicit-role invitation (batch: %s)",
  async (batch) => {
    let restore!: (items: readonly OutgoingEvent[]) => void;
    const loaded = new Promise<readonly OutgoingEvent[]>((resolve) => {
      restore = resolve;
    });
    const t = setup("stream", { load: () => loaded, save: () => {} });
    await t.ready();
    const original = signed(t.owner, {
      kind: 9000,
      content: "",
      tags: [
        ["h", t.id],
        ["p", t.person.pubkey],
        ["role", "member"],
      ],
    });
    // A separate invitation can make the member visible before the original.
    await t.receive(
      signed(t.owner, {
        kind: 9000,
        content: "",
        tags: [
          ["h", t.id],
          ["p", t.person.pubkey],
        ],
      }),
    );
    const changing = t.call("owner_member_set_role", {
      channel: t.id,
      pubkey: t.person.pubkey,
      expected_role: "member",
      role: "guest",
    });
    restore([
      {
        event: original,
        signed: original,
        delivery: "unknown",
        ...(batch
          ? { recovery: { key: `member-add:batch:${t.id}`, value: "1" } }
          : {}),
      },
    ]);
    const changed = await changing;
    // The delayed original would undo a downgrade that claimed confirmation.
    await t.receive(original);
    expect(changed).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("unresolved"),
    });
    expect(t.roles.get(t.person.pubkey)).toBe("member");
    // Roster presence alone must not retire a still-unknown original single.
    expect(
      await t.call("owner_member_add", {
        channel: t.id,
        pubkey: t.person.pubkey,
      }),
    ).toMatchObject({ status: "confirmed", role: "member" });
    expect(
      await t.call("owner_member_remove", {
        channel: t.id,
        pubkey: t.person.pubkey,
      }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("unresolved"),
    });
    t.echo(original);
    expect(
      await t.call("owner_member_set_role", {
        channel: t.id,
        pubkey: t.person.pubkey,
        expected_role: "member",
        role: "guest",
      }),
    ).toMatchObject({ status: "confirmed", role: "guest" });
    expect(t.roles.get(t.person.pubkey)).toBe("guest");
  },
);

it.each([false, true])(
  "rechecks unresolved invitations after role signing (batch: %s)",
  async (batch) => {
    const t = setup();
    await t.ready();
    t.roles.set(t.person.pubkey, "member");
    const held = t.holdSigning();
    const changing = t.call("owner_member_set_role", {
      channel: t.id,
      pubkey: t.person.pubkey,
      expected_role: "member",
      role: "guest",
    });
    let invitation: string | undefined;
    try {
      await held.started;
      t.failNext(new Error("Receipt lost"));
      invitation = t.session.outbox?.send(
        {
          kind: 9000,
          content: "",
          tags: [
            ["h", t.id],
            ["p", t.person.pubkey],
            ["role", "member"],
          ],
        },
        batch ? { key: `member-add:batch:${t.id}`, value: "1" } : undefined,
      );
      await vi.waitFor(() =>
        expect(t.session.outbox?.snapshot()).toContainEqual(
          expect.objectContaining({
            event: expect.objectContaining({ id: invitation }),
            delivery: "unknown",
          }),
        ),
      );
    } finally {
      held.release();
    }
    expect(await changing).toMatchObject({ status: "rejected" });
    expect(commands(t)).toHaveLength(0);
    expect(t.roles.get(t.person.pubkey)).toBe("member");
  },
);

it("reports a removal or role change whose receipt was lost as possibly applied", async () => {
  for (const name of ["owner_member_remove", "owner_member_set_role"]) {
    const t = setup();
    await t.ready();
    t.roles.set(t.person.pubkey, "member");
    t.failNext(new Error("Receipt lost"));
    const result = await t.call(name, {
      channel: t.id,
      pubkey: t.person.pubkey,
      ...(name === "owner_member_set_role"
        ? { role: "guest", expected_role: "member" }
        : {}),
    });
    expect(result).toMatchObject({ status: "unconfirmed" });
    expect(result.operation).toMatch(/^[0-9a-f]{64}$/);
  }
});
