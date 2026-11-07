// Owner channel writes through a real relay session: its outbox, channel
// writes, details and lifecycle services, against a fixture relay that applies
// the commands it accepts to its own signed channel records.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { OwnerMutationCaller } from "../../buzz-mcp/client";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { type OutgoingEvent, PublishRejected } from "../relay/outbox";
import { createRelaySession } from "../relay/session";
import { type Key, keypair, signed } from "../relay/testing";
import { SOLO_LABEL } from "../solo/labels";
import {
  createOwnerAccess,
  type OwnerBinding,
  type OwnerSession,
  ownerMutationActive,
} from "./owner-access";

const community = "https://relay.example.test";
const existing = "11111111-1111-4111-8111-111111111111";
const fresh = "22222222-2222-4222-8222-222222222222";
const system = "33333333-3333-4333-8333-333333333333";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

type Channel = { tags: string[][]; roles: Record<string, string> };

/** A relay that applies the 9007, 9002 and 9008 commands it accepts to its
 * own signed 39000–39002 records, and keeps each command it stored. */
function fixtureRelay(owner: Key, relay: Key) {
  const channels = new Map<string, Channel>();
  const stored: RelayEvent[] = [];
  const published: RelayEvent[] = [];
  let time = 1_700_000_000;
  const script: {
    /** Holds publication until released. */
    hold?: Promise<void>;
    /** Thrown after the command is stored: a lost acknowledgment. */
    lose?: Error;
    /** Thrown once publication starts, before the relay applies it. */
    drop?: Error;
    reject?: string;
  } = {};
  const roster = (roles: Channel["roles"]) =>
    Object.entries(roles).map(([key, role]) => ["p", key, "", role]);
  let cache: { at: number; events: RelayEvent[] } | undefined;
  const records = () => {
    if (cache?.at === time) return cache.events;
    const events = [...channels].flatMap(([id, channel]) => [
      signed(relay, {
        kind: 39000,
        created_at: time,
        content: "",
        tags: [["d", id], ...channel.tags],
      }),
      signed(relay, {
        kind: 39001,
        created_at: time,
        content: "",
        tags: [
          ["d", id],
          ...Object.entries(channel.roles)
            .filter(([, role]) => role === "owner" || role === "admin")
            .map(([key, role]) => ["p", key, role]),
        ],
      }),
      signed(relay, {
        kind: 39002,
        created_at: time,
        content: "",
        tags: [["d", id], ...roster(channel.roles)],
      }),
    ]);
    cache = { at: time, events };
    return events;
  };
  const replace = (tags: string[][], name: string, value?: string[]) => [
    ...tags.filter(([key]) => key !== name),
    ...(value ? [value] : []),
  ];
  function apply(event: RelayEvent) {
    const tag = (name: string) => event.tags.find(([key]) => key === name)?.[1];
    const id = tag("h") ?? "";
    time += 1;
    if (event.kind === 9007) {
      if (channels.has(id))
        throw new PublishRejected("duplicate: channel exists");
      const labels = event.tags.filter(([key]) => key === "t");
      channels.set(id, {
        tags: [
          ["name", tag("name") ?? ""],
          ["t", tag("channel_type") ?? "stream"],
          ...labels,
          [tag("visibility") === "open" ? "public" : "private"],
          ...(tag("about") ? [["about", tag("about") ?? ""]] : []),
          ...(tag("ttl") ? [["ttl", tag("ttl") ?? ""]] : []),
          ["P", event.pubkey],
        ],
        roles: { [event.pubkey]: "owner" },
      });
      return;
    }
    const channel = channels.get(id);
    if (!channel) throw new PublishRejected("invalid: no such channel");
    if (event.kind === 9008) {
      channels.delete(id);
      return;
    }
    let tags = channel.tags;
    for (const [name, value] of event.tags.slice(1)) {
      if (name === "visibility")
        tags = replace(replace(tags, "public"), "private", [
          value === "open" ? "public" : "private",
        ]);
      else if (name === "ttl")
        tags = replace(tags, "ttl", value ? ["ttl", value] : undefined);
      else tags = replace(tags, name ?? "", [name ?? "", value ?? ""]);
    }
    channel.tags = tags;
  }
  const sign = vi.fn(async (template: EventTemplate, _signal: AbortSignal) =>
    signed(owner, template),
  );
  const writer = {
    kinds: [9007, 9002, 9008],
    sign,
    publish: vi.fn(async (event: RelayEvent) => {
      await script.hold;
      if (script.reject) throw new PublishRejected(script.reject);
      if (script.drop) throw script.drop;
      published.push(event);
      apply(event);
      stored.push(event);
      if (script.lose) throw script.lose;
    }),
  };
  const fixture = {
    onQuery: undefined as
      | ((filters: readonly ReadFilter[]) => void)
      | undefined,
  };
  const query = async (filters: readonly ReadFilter[]) => {
    const events = [...records(), ...stored].filter((event) =>
      filters.some((filter) => matches(filter, event)),
    );
    fixture.onQuery?.(filters);
    return events;
  };
  return Object.assign(fixture, {
    channels,
    script,
    sign,
    writer,
    published,
    query,
    seed(id: string, tags: string[][], roles: Channel["roles"]) {
      time += 1;
      channels.set(id, { tags, roles });
    },
  });
}

function matches(filter: ReadFilter, event: RelayEvent) {
  const tagged = (name: string) => {
    const wanted = filter[`#${name}`];
    return (
      !wanted ||
      event.tags.some(
        ([key, value]) => key === name && wanted.includes(value ?? ""),
      )
    );
  };
  return (
    (!filter.ids || filter.ids.includes(event.id)) &&
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    tagged("d") &&
    tagged("h") &&
    tagged("p")
  );
}

/** The owner's real session on the fixture relay, an agent bound to it, and
 * a turn the test can end. */
async function setup() {
  const owner = keypair(),
    relay = keypair(),
    agent = keypair();
  const fixture = fixtureRelay(owner, relay);
  fixture.seed(
    existing,
    [["name", "Plans"], ["t", "stream"], ["private"], ["P", owner.pubkey]],
    { [owner.pubkey]: "owner" },
  );
  fixture.seed(system, [["name", "App data"], ["t", "system"], ["private"]], {
    [owner.pubkey]: "owner",
  });
  let journal: readonly OutgoingEvent[] = [];
  const outboxStorage = {
    load: () => structuredClone(journal),
    save: (next: readonly OutgoingEvent[]) => {
      journal = structuredClone(next);
    },
  };
  const live = createRelaySession(
    {
      viewer: owner.pubkey,
      relayAuthor: relay.pubkey,
      channelIdentity: true,
      media: () => undefined,
      query: fixture.query,
      writer: fixture.writer,
      channelDetails: fixture.writer,
      channelLifecycle: fixture.writer,
    },
    { outboxStorage },
  );
  disposers.push(live.dispose);
  live.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(live.session.channels.list().status).toBe("ready"),
  );
  const replaced = new AbortController();
  const lifetime = new AbortController();
  const state = {
    binding: {
      viewer: owner.pubkey,
      origin: community,
      session: live.session as unknown as OwnerSession,
      signal: replaced.signal,
    } as OwnerBinding | undefined,
  };
  const access = createOwnerAccess(
    { pubkey: agent.pubkey, owner: owner.pubkey },
    () => state.binding,
    lifetime.signal,
  );
  const turn = { ended: false, controller: new AbortController() };
  const caller: OwnerMutationCaller = {
    signal: turn.controller.signal,
    check: () => {
      if (turn.ended) throw new Error("The turn has ended");
    },
  };
  return {
    owner,
    agent,
    fixture,
    session: live.session,
    dispose: live.dispose,
    access,
    caller,
    turn,
    state,
    replaced,
    lifetime,
  };
}

const plans = { id: fresh, name: "Launch", visibility: "open" as const };

describe("owner_channel_create", () => {
  it("creates the channel with the owner as its owner, without adding the agent", async () => {
    const t = await setup();
    const result = await t.access.createChannel(
      { ...plans, description: " Next quarter ", ttlSeconds: 3600 },
      t.caller,
    );
    expect(result).toMatchObject({
      action: "create",
      channel: fresh,
      outcome: "confirmed",
      ownerRole: "owner",
      callerMember: false,
      execution: { agent: t.agent.pubkey, owner: t.owner.pubkey, community },
    });
    expect(result.operation).toBe(t.fixture.published[0]?.id);
    expect(t.fixture.published[0]?.tags).toEqual(
      expect.arrayContaining([
        ["h", fresh],
        ["name", "Launch"],
        ["visibility", "open"],
        ["about", "Next quarter"],
        ["ttl", "3600"],
      ]),
    );
    expect(t.fixture.published[0]?.tags.some(([key]) => key === "p")).toBe(
      false,
    );
    // It lists in the owner's session, and its receipt is settled.
    expect(
      t.session.channels.list().channels.some(({ id }) => id === fresh),
    ).toBe(true);
    expect(t.session.outbox?.snapshot()).toEqual([]);

    // The same call again confirms it; nothing more is signed.
    await expect(
      t.access.createChannel(
        { ...plans, description: "Next quarter", ttlSeconds: 3600 },
        t.caller,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed", ownerRole: "owner" });
    // Different details under that ID are a conflict, never a second channel.
    await expect(
      t.access.createChannel({ ...plans, name: "Other" }, t.caller),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
    expect(t.fixture.sign).toHaveBeenCalledOnce();
  });

  it("creates a private Solo chat with only the owner in it", async () => {
    const t = await setup();
    await expect(
      t.access.createChannel(
        { id: fresh, name: "Me", visibility: "private", solo: true },
        t.caller,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed", callerMember: false });
    const tags = t.fixture.published[0]?.tags ?? [];
    expect(tags).toContainEqual(["t", SOLO_LABEL]);
    expect(tags).toContainEqual(["visibility", "private"]);
    expect(tags.some(([key]) => key === "p")).toBe(false);
  });

  it("answers unconfirmed after a lost acknowledgment, and the same call resumes the same command", async () => {
    const t = await setup();
    t.fixture.script.lose = new Error("connection lost");
    const first = await t.access.createChannel(plans, t.caller);
    expect(first).toMatchObject({ outcome: "unconfirmed" });
    expect(first.operation).toBe(t.fixture.published[0]?.id);
    delete t.fixture.script.lose;
    // The relay already holds it: the retry confirms that command.
    const again = await t.access.createChannel(
      { ...plans, operation: first.operation },
      t.caller,
    );
    expect(again).toMatchObject({
      outcome: "confirmed",
      operation: first.operation,
      ownerRole: "owner",
    });
    expect(t.fixture.sign).toHaveBeenCalledOnce();
    expect(t.fixture.published).toHaveLength(1);
  });

  it("never signs a replacement for a possibly sent create whose receipt is gone", async () => {
    const t = await setup();
    t.fixture.script.drop = new Error("connection lost");
    const first = await t.access.createChannel(plans, t.caller);
    expect(first).toMatchObject({ outcome: "unconfirmed" });
    const operation = first.operation ?? "";
    expect(operation).toMatch(/^[0-9a-f]{64}$/);
    // The owner clears the receipt; the relay shows no channel either.
    await vi.waitFor(async () => {
      await t.session.outbox?.dismiss(operation);
      expect(t.session.outbox?.snapshot()).toEqual([]);
    });
    delete t.fixture.script.drop;
    const signedBefore = t.fixture.sign.mock.calls.length;
    const publishedBefore = t.fixture.writer.publish.mock.calls.length;

    // A later call resuming that create cannot tell it from a new one.
    const again = await t.access.createChannel(
      { ...plans, operation },
      t.caller,
    );
    expect(again).toMatchObject({ outcome: "unconfirmed", operation });
    expect(again.error).toContain("owner_channel_get");
    expect(t.fixture.sign).toHaveBeenCalledTimes(signedBefore);
    expect(t.fixture.writer.publish).toHaveBeenCalledTimes(publishedBefore);
    expect(t.fixture.channels.has(fresh)).toBe(false);

    // Absence proved nothing: once the channel appears, resuming confirms it.
    t.fixture.seed(
      fresh,
      [["name", "Launch"], ["t", "stream"], ["public"], ["P", t.owner.pubkey]],
      { [t.owner.pubkey]: "owner" },
    );
    await expect(
      t.access.createChannel({ ...plans, operation }, t.caller),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      operation,
      ownerRole: "owner",
    });
    expect(t.fixture.sign).toHaveBeenCalledTimes(signedBefore);
  });

  it.each(["system", "Solo with members"] as const)(
    "does not resume a queued %s create as a narrower owner-tool request",
    async (kind) => {
      const t = await setup();
      // Another supported app path queued a broader create, but signing failed.
      t.fixture.sign.mockRejectedValueOnce(new Error("signer unavailable"));
      const operation =
        kind === "system"
          ? t.session.channelWrites.createChannel(
              fresh,
              plans.name,
              "open",
              undefined,
              undefined,
              undefined,
              { system: true },
            )
          : t.session.channelWrites.create(fresh, plans.name, undefined, true, [
              t.agent.pubkey,
            ]);
      await vi.waitFor(() =>
        expect(t.session.outbox?.snapshot()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: expect.objectContaining({ id: operation }),
              delivery: "failed",
            }),
          ]),
        ),
      );
      const signedBefore = t.fixture.sign.mock.calls.length;
      await expect(
        t.access.createChannel(
          {
            ...plans,
            ...(kind === "Solo with members"
              ? { solo: true, visibility: "private" as const }
              : {}),
            operation,
          },
          t.caller,
        ),
      ).resolves.toMatchObject({
        outcome: "rejected",
        reason: "conflict",
        operation,
      });
      expect(t.fixture.sign).toHaveBeenCalledTimes(signedBefore);
      expect(t.fixture.writer.publish).not.toHaveBeenCalled();
    },
  );

  it("signs one create for parallel calls with the same ID, and none for a different intent", async () => {
    const t = await setup();
    const held = gate();
    t.fixture.script.hold = held.promise;
    const first = t.access.createChannel(plans, t.caller);
    const second = t.access.createChannel(plans, t.caller);
    try {
      await vi.waitFor(() =>
        expect(t.fixture.writer.publish).toHaveBeenCalledOnce(),
      );
      // While that create is still queued, other details or another create's
      // receipt under its ID conflict.
      await expect(
        t.access.createChannel({ ...plans, name: "Other" }, t.caller),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
      await expect(
        t.access.createChannel(
          { ...plans, operation: "f".repeat(64) },
          t.caller,
        ),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
    } finally {
      held.open();
    }
    const answers = await Promise.all([first, second]);
    expect(answers.map(({ outcome }) => outcome)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(answers[1]?.operation).toBe(answers[0]?.operation);
    expect(t.fixture.sign).toHaveBeenCalledOnce();
  });

  it("is rejected, changing nothing, when the relay refuses it", async () => {
    const t = await setup();
    t.fixture.script.reject = "blocked: not allowed";
    await expect(
      t.access.createChannel(plans, t.caller),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "refused" });
    expect(t.fixture.channels.has(fresh)).toBe(false);
  });

  it("signs nothing once the turn ends before the command is queued", async () => {
    const t = await setup();
    // The turn ends while the create's existence check reads the relay.
    t.fixture.onQuery = (filters) => {
      if (filters.some((filter) => filter["#d"]?.includes(fresh)))
        t.turn.ended = true;
    };
    await expect(
      t.access.createChannel(plans, t.caller),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "cancelled" });
    expect(t.fixture.sign).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the turn ends",
      (t: Awaited<ReturnType<typeof setup>>) => {
        t.turn.ended = true;
      },
    ],
    [
      "the turn is stopped",
      (t: Awaited<ReturnType<typeof setup>>) => {
        t.turn.controller.abort();
      },
    ],
    [
      "the owner switches accounts",
      (t: Awaited<ReturnType<typeof setup>>) => {
        t.state.binding = undefined;
      },
    ],
    [
      "the agent stops running here",
      (t: Awaited<ReturnType<typeof setup>>) => {
        t.lifetime.abort();
      },
    ],
  ])(
    "publishes nothing when %s while the command is being signed",
    async (_, end) => {
      const t = await setup();
      const signing = gate();
      const release = gate();
      t.fixture.sign.mockImplementationOnce(async (template) => {
        signing.open();
        await release.promise;
        return signed(t.owner, template);
      });
      const pending = t.access.createChannel(plans, t.caller);
      try {
        await signing.promise;
        end(t);
      } finally {
        release.open();
      }
      const result = await pending;
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toBe("cancelled");
      expect(t.fixture.writer.publish).not.toHaveBeenCalled();
      expect(t.fixture.channels.has(fresh)).toBe(false);
    },
  );

  it("refuses a caller the host did not supply, and an agent no longer running here", async () => {
    const t = await setup();
    await expect(t.access.createChannel(plans)).rejects.toThrow(
      "unavailable to this caller",
    );
    t.lifetime.abort();
    await expect(t.access.createChannel(plans, t.caller)).rejects.toThrow();
    expect(t.fixture.sign).not.toHaveBeenCalled();
  });
});

describe("owner_channel_update", () => {
  it("pairs the fresh editable settings with their version while discovery still has old values", async () => {
    const t = await setup();
    t.fixture.seed(
      existing,
      [
        ["name", "Changed elsewhere"],
        ["t", "stream"],
        ["public"],
        ["about", "Current description"],
        ["join_role", "guest"],
        ["ttl", "7200"],
        ["P", t.owner.pubkey],
      ],
      { [t.owner.pubkey]: "owner" },
    );
    expect(
      t.session.channels.list().channels.find(({ id }) => id === existing)
        ?.name,
    ).toBe("Plans");
    const { channel } = await t.access.channel(existing);
    expect(channel).toMatchObject({
      name: "Changed elsewhere",
      description: "Current description",
      visibility: "open",
      joinRole: "guest",
      ttlSeconds: 7200,
    });
    expect(channel.version).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      t.access.updateChannel(
        {
          id: existing,
          version: channel.version ?? "",
          description: "New description",
        },
        t.caller,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed" });
    expect(t.fixture.channels.get(existing)?.tags).toContainEqual([
      "name",
      "Changed elsewhere",
    ]);
  });

  it("saves exactly the given fields against the version read", async () => {
    const t = await setup();
    const { channel } = await t.access.channel(existing);
    expect(channel.version).toMatch(/^[0-9a-f]{64}$/);
    const result = await t.access.updateChannel(
      {
        id: existing,
        version: channel.version ?? "",
        description: "Shipping",
        visibility: "public",
      },
      t.caller,
    );
    expect(result).toMatchObject({ outcome: "confirmed", ownerRole: "owner" });
    expect(result.version).not.toBe(channel.version);
    const tags = t.fixture.channels.get(existing)?.tags ?? [];
    expect(tags).toEqual(
      expect.arrayContaining([
        ["name", "Plans"],
        ["about", "Shipping"],
        ["public"],
      ]),
    );
  });

  it("saves nothing over a newer version, and saves over the version it answered", async () => {
    const t = await setup();
    const { channel } = await t.access.channel(existing);
    const saved = await t.access.updateChannel(
      { id: existing, version: channel.version ?? "", name: "Plans 2" },
      t.caller,
    );
    const stale = await t.access.updateChannel(
      { id: existing, version: channel.version ?? "", name: "Plans 3" },
      t.caller,
    );
    expect(stale).toMatchObject({ outcome: "rejected", reason: "conflict" });
    expect(stale.version).toBe(saved.version);
    expect(t.fixture.sign).toHaveBeenCalledOnce();
    await expect(
      t.access.updateChannel(
        { id: existing, version: saved.version ?? "", name: "Plans 3" },
        t.caller,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed" });
  });

  it("is cancelled before publication once the turn ends, and unconfirmed once it may have been sent", async () => {
    const t = await setup();
    const { channel } = await t.access.channel(existing);
    const signing = gate();
    const release = gate();
    t.fixture.sign.mockImplementationOnce(async (template) => {
      signing.open();
      await release.promise;
      return signed(t.owner, template);
    });
    const pending = t.access.updateChannel(
      { id: existing, version: channel.version ?? "", name: "Renamed" },
      t.caller,
    );
    try {
      await signing.promise;
      t.turn.ended = true;
    } finally {
      release.open();
    }
    await expect(pending).resolves.toMatchObject({
      outcome: "rejected",
      reason: "cancelled",
    });
    expect(t.fixture.writer.publish).not.toHaveBeenCalled();

    t.turn.ended = false;
    t.fixture.script.lose = new Error("connection lost");
    // The relay applies it but the answer is lost: never "nothing happened".
    const sent = await t.access.updateChannel(
      { id: existing, version: channel.version ?? "", name: "Renamed" },
      t.caller,
    );
    expect(sent.outcome).toBe("unconfirmed");
    delete t.fixture.script.lose;
    // Its readback settles it, so the next call sees the newer version.
    await expect(
      t.access.updateChannel(
        { id: existing, version: channel.version ?? "", name: "Again" },
        t.caller,
      ),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
  });

  it("stays busy while an earlier unconfirmed save cannot be read back", async () => {
    const t = await setup();
    const { channel } = await t.access.channel(existing);
    t.fixture.script.drop = new Error("connection lost");
    const change = { id: existing, version: channel.version ?? "", name: "X" };
    await expect(
      t.access.updateChannel(change, t.caller),
    ).resolves.toMatchObject({ outcome: "unconfirmed" });
    delete t.fixture.script.drop;
    await expect(
      t.access.updateChannel(change, t.caller),
    ).resolves.toMatchObject({ outcome: "rejected", reason: "busy" });
    expect(t.fixture.writer.publish).toHaveBeenCalledOnce();
  });

  it("remains unconfirmed if the owner session closes after publication starts", async () => {
    const t = await setup();
    const { channel } = await t.access.channel(existing);
    const held = gate();
    t.fixture.script.hold = held.promise;
    const pending = t.access.updateChannel(
      { id: existing, version: channel.version ?? "", name: "Renamed" },
      t.caller,
    );
    try {
      await vi.waitFor(() =>
        expect(t.fixture.writer.publish).toHaveBeenCalledOnce(),
      );
      t.dispose();
    } finally {
      held.open();
    }
    await expect(pending).resolves.toMatchObject({ outcome: "unconfirmed" });
    expect(t.fixture.channels.get(existing)?.tags).toContainEqual([
      "name",
      "Renamed",
    ]);
  });
});

describe("owner channel lifecycle", () => {
  it("creates, inspects, updates, archives, rediscovers, unarchives and deletes by exact ID", async () => {
    const t = await setup();
    await expect(
      t.access.createChannel(plans, t.caller),
    ).resolves.toMatchObject({ outcome: "confirmed", callerMember: false });
    const { channel } = await t.access.channel(fresh);
    await expect(
      t.access.updateChannel(
        { id: fresh, version: channel.version ?? "", name: "Launch plan" },
        t.caller,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed", callerMember: false });
    await expect(
      t.access.changeChannel("archive", fresh, t.caller),
    ).resolves.toMatchObject({ outcome: "confirmed", ownerRole: "owner" });
    expect(t.fixture.channels.get(fresh)?.tags).toContainEqual([
      "archived",
      "true",
    ]);
    expect((await t.access.channels()).channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fresh, archived: true }),
      ]),
    );
    await expect(
      t.access.changeChannel("unarchive", fresh, t.caller),
    ).resolves.toMatchObject({ outcome: "confirmed" });
    await expect(
      t.access.changeChannel("delete", fresh, t.caller),
    ).resolves.toMatchObject({ action: "delete", outcome: "confirmed" });
    expect(t.fixture.channels.has(fresh)).toBe(false);
  });

  it("answers busy, not success, while another channel action runs", async () => {
    const t = await setup();
    const held = gate();
    t.fixture.script.hold = held.promise;
    const first = t.access.changeChannel("archive", existing, t.caller);
    try {
      await vi.waitFor(() =>
        expect(t.fixture.writer.publish).toHaveBeenCalledOnce(),
      );
      await expect(
        t.access.changeChannel("delete", existing, t.caller),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "busy" });
    } finally {
      held.open();
    }
    await expect(first).resolves.toMatchObject({ outcome: "confirmed" });
    expect(t.fixture.channels.has(existing)).toBe(true);
  });

  it("is unconfirmed when the command may have been sent", async () => {
    const t = await setup();
    t.fixture.script.lose = new Error("connection lost");
    await expect(
      t.access.changeChannel("delete", existing, t.caller),
    ).resolves.toMatchObject({ outcome: "unconfirmed" });
  });

  it("changes no system channel and no unknown action", async () => {
    const t = await setup();
    await expect(
      t.access.changeChannel("delete", system, t.caller),
    ).rejects.toThrow();
    await expect(
      t.access.changeChannel("hide" as "delete", existing, t.caller),
    ).rejects.toThrow("No channel action");
    expect(t.fixture.sign).not.toHaveBeenCalled();
  });
});

describe("owner channel signing admission", () => {
  it.each(["update", "archive", "unarchive", "delete"] as const)(
    "signs no %s command if the caller retires during authority reads",
    async (action) => {
      const t = await setup();
      if (action === "unarchive")
        t.fixture.seed(
          existing,
          [
            ["name", "Plans"],
            ["t", "stream"],
            ["private"],
            ["P", t.owner.pubkey],
            ["archived", "true"],
          ],
          { [t.owner.pubkey]: "owner" },
        );
      const { channel } = await t.access.channel(existing);
      t.fixture.onQuery = (filters) => {
        if (filters.some((filter) => filter["#d"]?.includes(existing)))
          t.turn.ended = true;
      };
      const result =
        action === "update"
          ? await t.access.updateChannel(
              { id: existing, version: channel.version ?? "", name: "Renamed" },
              t.caller,
            )
          : await t.access.changeChannel(action, existing, t.caller);
      expect(t.turn.ended).toBe(true);
      expect(result).toMatchObject({
        outcome: "rejected",
        reason: "cancelled",
      });
      expect(t.fixture.sign).not.toHaveBeenCalled();
      expect(t.fixture.writer.publish).not.toHaveBeenCalled();
    },
  );
});

describe("ownerMutationActive", () => {
  const binding = (patch: Partial<OwnerBinding> = {}): OwnerBinding => ({
    viewer: "owner",
    origin: community,
    session: {} as OwnerSession,
    signal: new AbortController().signal,
    ...patch,
  });
  const caller = (check = () => {}): OwnerMutationCaller => ({ check });

  it("holds only while the caller, binding, lifetime and recorded owner all hold", () => {
    const admitted = binding();
    expect(
      ownerMutationActive("owner", admitted, () => admitted, caller())(),
    ).toBe(true);
    const ended = caller(() => {
      throw new Error("ended");
    });
    expect(
      ownerMutationActive("owner", admitted, () => admitted, ended)(),
    ).toBe(false);
    const stopped = new AbortController();
    stopped.abort();
    expect(
      ownerMutationActive("owner", admitted, () => admitted, {
        signal: stopped.signal,
        check: () => {},
      })(),
    ).toBe(false);
    expect(
      ownerMutationActive(
        "owner",
        admitted,
        () => admitted,
        caller(),
        stopped.signal,
      )(),
    ).toBe(false);
    expect(
      ownerMutationActive("owner", admitted, () => undefined, caller())(),
    ).toBe(false);
    for (const now of [
      binding({ session: {} as OwnerSession }),
      binding({ viewer: "someone", session: admitted.session }),
      binding({
        origin: "https://other.example.test",
        session: admitted.session,
      }),
      binding({ signal: stopped.signal, session: admitted.session }),
    ])
      expect(
        ownerMutationActive("owner", admitted, () => now, caller())(),
      ).toBe(false);
    expect(
      ownerMutationActive("another", admitted, () => admitted, caller())(),
    ).toBe(false);
  });
});
