import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, metadata, ownedProfile, signed } from "./testing";
import { matchesEvent } from "./projection";
import { SOLO_LABEL } from "../solo/labels";
import { soloAdminKey } from "./solo-admins";
import { validateMemberAdministrationTemplate } from "../channel-members/administration-protocol";
import type { OutgoingEvent } from "./outbox";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import type { EventTemplate } from "nostr-tools";

const sessions: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function setup() {
  const viewer = keypair(),
    relay = keypair();
  const channel = crypto.randomUUID();
  const agentKeys = [keypair(), keypair()] as const;
  const agents: [string, string] = [agentKeys[0].pubkey, agentKeys[1].pubkey];
  const workspaceKey = keypair();
  const workspaceAgent = workspaceKey.pubkey;
  const profiles = Promise.all(
    [...agentKeys, workspaceKey].map((key) => ownedProfile(key, viewer)),
  );
  let beforeLock = async () => {};
  const profileOverrides = new Map<string, RelayEvent>();
  let omitProfiles = false;
  let failProfiles = false;
  let failGrantReads = false;
  let failCreateReads = false;
  let blockedCreateReads = 0;
  let finished = false;
  let journal: readonly OutgoingEvent[] = [];
  const unfinished = (items: readonly OutgoingEvent[]) =>
    finished
      ? items.filter((item) => item.recovery?.key !== soloAdminKey(channel))
      : items;
  const events = new Map<string, RelayEvent>();
  const roles = new Map<string, string>();
  const genericPublish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9000)
      throw new Error("Elevated commands require their dedicated host route");
    events.set(event.id, event);
    if (event.kind === 9007) {
      roles.set(viewer.pubkey, "owner");
      for (const [tag, key] of event.tags)
        if (tag === "p" && key) roles.set(key, "member");
    }
  });
  const adminPublish = vi.fn(async (event: RelayEvent) => {
    validateMemberAdministrationTemplate(event, viewer.pubkey);
    if (events.has(event.id)) return;
    events.set(event.id, event);
    const agent = event.tags.find(([tag]) => tag === "p")?.[1];
    assert.exists(agent);
    roles.set(agent, "admin");
  });
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    channelIdentity: true as const,
    media: () => undefined,
    query: async (filters: readonly ReadFilter[]) => {
      if (failProfiles && filters.some((filter) => filter.kinds?.includes(0)))
        throw new Error("Profile read unavailable");
      if (
        failGrantReads &&
        filters.some((filter) => filter.kinds?.includes(9000) && filter.ids)
      )
        throw new Error("Grant read unavailable");
      if (
        failCreateReads &&
        filters.some((filter) =>
          filter.ids?.some((id) => events.get(id)?.kind === 9007),
        )
      ) {
        blockedCreateReads++;
        throw new Error("Create read unavailable");
      }
      const roster = signed(relay, {
        kind: 39002,
        content: "",
        tags: [
          ["d", channel],
          ...[...roles].map(([key, role]) => ["p", key, "", role]),
        ],
      });
      return [
        ...(omitProfiles ? [] : await profiles).map((profile) =>
          eventDto(profileOverrides.get(profile.pubkey) ?? profile),
        ),
        ...[...events.values()].filter(
          (event) => !failCreateReads || event.kind !== 9007,
        ),
        ...(roles.size
          ? [
              roster,
              metadata(relay, channel, "Work", Math.floor(Date.now() / 1000), [
                ["t", "stream"],
                ["private"],
                ["t", SOLO_LABEL],
                ["P", viewer.pubkey],
              ]),
            ]
          : []),
      ].filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    writer: {
      kinds: [9, 9000, 9007],
      sign: async (template: EventTemplate) => signed(viewer, template),
      publish: genericPublish,
    },
    memberAdministration: {
      sign: async (template: EventTemplate) => {
        validateMemberAdministrationTemplate(template, viewer.pubkey);
        return signed(viewer, template);
      },
      publish: adminPublish,
    },
  };
  const open = async () => {
    const owner = createRelaySession(transport, {
      outboxStorage: {
        async lock(_id, run) {
          await beforeLock();
          return run();
        },
        load: () => structuredClone(journal),
        save: (next) => {
          journal = structuredClone(unfinished(next));
        },
      },
    });
    sessions.push(owner);
    await owner.session.outbox?.ready();
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    return owner;
  };
  const start = (owner: Awaited<ReturnType<typeof open>>) => {
    const creation = owner.session.channelWrites.start(
      channel,
      "Work",
      [...agents, workspaceAgent],
      undefined,
      false,
      undefined,
      { admins: [...agents, workspaceAgent] },
    );
    void creation.ready.catch(() => {});
    const message = owner.session.messages.send(
      channel,
      "Work on this",
      agents,
    );
    return { creation, message };
  };
  const replaceProfile = async (
    owner: Awaited<ReturnType<typeof open>>,
    index: number,
    by: ReturnType<typeof keypair>,
    receive: boolean,
  ) => {
    const agent = agentKeys[index];
    assert.exists(agent);
    const profile = await ownedProfile(agent, by);
    const previous = (await profiles).find(
      (event) => event.pubkey === agent.pubkey,
    );
    assert.exists(previous);
    const changed = signed(agent, {
      ...profile,
      created_at: previous.created_at + 1,
    });
    profileOverrides.set(agent.pubkey, changed);
    if (!receive) return;
    await owner.session.read(
      [{ kinds: [0], authors: [agent.pubkey], limit: 1 }],
      { fresh: true },
    );
    expect(owner.session.profiles.event?.(agent.pubkey)?.id).toBe(changed.id);
  };
  return {
    channel,
    viewer,
    transferAgent: (
      owner: Awaited<ReturnType<typeof open>>,
      index: number,
      receive = true,
    ) => replaceProfile(owner, index, keypair(), receive),
    editAgent: (owner: Awaited<ReturnType<typeof open>>, index: number) =>
      replaceProfile(owner, index, viewer, true),
    omitProfiles: () => {
      omitProfiles = true;
    },
    failProfiles: () => {
      failProfiles = true;
    },
    failGrantReads: () => {
      failGrantReads = true;
    },
    failCreateReads: () => {
      failCreateReads = true;
    },
    blockedCreateReads: () => blockedCreateReads,
    finishElsewhere: () => {
      finished = true;
      journal = unfinished(journal);
    },
    beforeLock: (run: () => Promise<void>) => {
      beforeLock = run;
    },
    agents,
    workspaceAgent,
    roles,
    events,
    genericPublish,
    adminPublish,
    transport,
    open,
    start,
  };
}

it("confirms a lost grant ACK and holds the opening message and local wake until every admin is ready", async () => {
  const h = setup();
  const owner = await h.open();
  const heard = vi.fn();
  owner.session.subscribeLive(heard, { replay: true });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = h.adminPublish.getMockImplementation();
  assert.exists(publish);
  h.adminPublish
    .mockImplementationOnce(async (event) => {
      await publish(event);
      throw new Error("ACK lost");
    })
    .mockImplementationOnce(async (event) => {
      await held;
      await publish(event);
    });
  try {
    const { message } = h.start(owner);
    await vi.waitFor(() => expect(h.adminPublish).toHaveBeenCalledTimes(2));
    expect(h.roles.get(h.agents[0])).toBe("admin");
    expect(h.roles.get(h.agents[1])).toBe("member");
    expect(h.genericPublish.mock.calls.map(([event]) => event.kind)).toEqual([
      9007,
    ]);
    expect(heard).not.toHaveBeenCalled();
    expect(
      owner.session.outbox
        ?.snapshot()
        .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
    ).toBe(true);
    release();
    await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
    expect(h.agents.map((key) => h.roles.get(key))).toEqual(["admin", "admin"]);
    expect(h.roles.get(h.workspaceAgent)).toBe("admin");
    expect(h.roles.get(h.viewer.pubkey)).toBe("owner");
    expect(h.adminPublish).toHaveBeenCalledTimes(3);
    expect(h.adminPublish.mock.calls.map(([event]) => event.tags)).toEqual(
      [...h.agents, h.workspaceAgent].map((key) => [
        ["h", h.channel],
        ["p", key],
        ["role", "admin"],
      ]),
    );
    const create = h.genericPublish.mock.calls.find(
      ([event]) => event.kind === 9007,
    )?.[0];
    assert.exists(create);
    expect(
      h.adminPublish.mock.calls.every(
        ([event]) =>
          event.pubkey === h.viewer.pubkey &&
          event.created_at === create.created_at,
      ),
    ).toBe(true);
    expect(
      owner.session.outbox
        ?.snapshot()
        .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
    ).toBe(false);
  } finally {
    release();
  }
});

it("resumes a partial setup from the durable outbox after restart without restoring a later demotion", async () => {
  const h = setup();
  const first = await h.open();
  const publish = h.adminPublish.getMockImplementation();
  assert.exists(publish);
  h.adminPublish
    .mockImplementationOnce(publish)
    .mockRejectedValueOnce(new Error("offline"));
  const { message } = h.start(first);
  await vi.waitFor(() =>
    expect(
      first.session.outbox?.snapshot().find((item) => item.event.id === message)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(h.events.has(message)).toBe(false);
  h.roles.set(h.agents[0], "bot");
  first.dispose();
  const resumed = await h.open();
  resumed.session.outbox?.retry(message);
  await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
  expect(h.roles.get(h.agents[0])).toBe("bot");
  expect(h.roles.get(h.agents[1])).toBe("admin");
  expect(
    h.adminPublish.mock.calls.filter(
      ([event]) => event.tags[1]?.[1] === h.agents[0],
    ),
  ).toHaveLength(1);
  const second = h.adminPublish.mock.calls.filter(
    ([event]) => event.tags[1]?.[1] === h.agents[1],
  );
  expect(second).toHaveLength(2);
  expect(second[0]?.[0].id).toBe(second[1]?.[0].id);
  expect(
    h.genericPublish.mock.calls.filter(([event]) => event.kind === 9),
  ).toHaveLength(1);
});

it.each([
  "grants are readable",
  "grants are unreadable",
  "the create is unreadable",
  "it cannot grant",
])(
  "finishes an expired setup on its own so the chat's next message sends with current roles when %s",
  async (connection) => {
    const h = setup();
    if (connection === "the create is unreadable") h.failCreateReads();
    const first = await h.open();
    h.adminPublish.mockRejectedValue(new Error("offline"));
    const { message } = h.start(first);
    await vi.waitFor(() =>
      expect(
        first.session.outbox
          ?.snapshot()
          .find((item) => item.event.id === message)?.delivery,
      ).toBe("failed"),
    );
    first.dispose();
    if (connection === "grants are unreadable") h.failGrantReads();
    if (connection === "it cannot grant")
      Reflect.deleteProperty(h.transport, "memberAdministration");
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      const resumed = await h.open();
      const next = resumed.session.messages.send(
        h.channel,
        "Continue with current roles",
        h.agents,
      );
      await vi.waitFor(() => expect(h.events.has(next)).toBe(true));
      expect(h.adminPublish).toHaveBeenCalledOnce();
      expect(h.agents.map((key) => h.roles.get(key))).toEqual([
        "member",
        "member",
      ]);
      expect(
        resumed.session.outbox
          ?.snapshot()
          .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  },
);

it("finishes setup that expires while a send waits on an unreadable create", async () => {
  const h = setup();
  h.failCreateReads();
  const first = await h.open();
  h.adminPublish.mockRejectedValue(new Error("offline"));
  const { message } = h.start(first);
  await vi.waitFor(() =>
    expect(
      first.session.outbox?.snapshot().find((item) => item.event.id === message)
        ?.delivery,
    ).toBe("failed"),
  );
  first.dispose();
  const resumed = await h.open();
  const blocked = h.blockedCreateReads();
  const next = resumed.session.messages.send(
    h.channel,
    "Continue with current roles",
    h.agents,
  );
  await vi.waitFor(() =>
    expect(h.blockedCreateReads()).toBeGreaterThan(blocked),
  );
  expect(h.events.has(next)).toBe(false);
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + 16 * 60 * 1000);
  try {
    await vi.waitFor(() => expect(h.events.has(next)).toBe(true), {
      timeout: 10_000,
    });
    expect(h.adminPublish).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
  }
}, 15_000);

it("skips an opening grant whose relay profile was transferred and still sends the message", async () => {
  const h = setup();
  const owner = await h.open();
  await owner.session.profiles.ensure(h.agents);
  const cached = owner.session.profiles.event?.(h.agents[0]);
  assert.exists(cached);
  await h.transferAgent(owner, 0, false);
  expect(owner.session.profiles.event?.(h.agents[0])).toBe(cached);
  const { message } = h.start(owner);
  await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
  expect(h.roles.get(h.agents[0])).toBe("member");
  expect(
    h.adminPublish.mock.calls.some(
      ([event]) => event.tags[1]?.[1] === h.agents[0],
    ),
  ).toBe(false);
  expect(
    owner.session.outbox
      ?.snapshot()
      .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
  ).toBe(false);
});

it.each([
  ["fails", "Profile read unavailable"],
  ["returns no profile", "profile is unavailable"],
])(
  "keeps setup when a profile read %s, so a retry can still grant",
  async (read, error) => {
    const h = setup();
    const owner = await h.open();
    if (read === "fails") h.failProfiles();
    else h.omitProfiles();
    const { creation, message } = h.start(owner);
    await creation.ready;
    await expect(
      owner.session.channelWrites.prepareOpening(h.channel),
    ).rejects.toThrow(error);
    await vi.waitFor(() =>
      expect(
        owner.session.outbox
          ?.snapshot()
          .find((item) => item.event.id === message)?.delivery,
      ).toBe("failed"),
    );
    expect(h.adminPublish).not.toHaveBeenCalled();
    expect(h.events.has(message)).toBe(false);
    expect(
      owner.session.outbox
        ?.snapshot()
        .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
    ).toBe(true);
  },
);

it("sends from a window whose setup another window already finished", async () => {
  const h = setup();
  const first = await h.open();
  h.adminPublish.mockRejectedValue(new Error("offline"));
  const { message } = h.start(first);
  await vi.waitFor(() =>
    expect(
      first.session.outbox?.snapshot().find((item) => item.event.id === message)
        ?.delivery,
    ).toBe("failed"),
  );
  const second = await h.open();
  first.dispose();
  h.finishElsewhere();
  const next = second.session.messages.send(
    h.channel,
    "From the other window",
    h.agents,
  );
  await vi.waitFor(() => expect(h.events.has(next)).toBe(true));
  expect(h.adminPublish).toHaveBeenCalledOnce();
});

it("sends from the creating window after another window finishes setup and a grant lookup fails", async () => {
  const h = setup();
  const owner = await h.open();
  h.adminPublish.mockRejectedValue(new Error("offline"));
  const { message } = h.start(owner);
  await vi.waitFor(() =>
    expect(
      owner.session.outbox?.snapshot().find((item) => item.event.id === message)
        ?.delivery,
    ).toBe("failed"),
  );
  h.finishElsewhere();
  h.failGrantReads();
  owner.session.outbox?.retry(message);
  await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
  expect(h.adminPublish).toHaveBeenCalledOnce();
});

it("sends the message when another window finishes setup while this one grants", async () => {
  const h = setup();
  const owner = await h.open();
  const sign = h.transport.memberAdministration.sign;
  h.transport.memberAdministration.sign = async (template) => {
    h.beforeLock(async () => {
      h.beforeLock(async () => {});
      h.finishElsewhere();
    });
    return sign(template);
  };
  const { message } = h.start(owner);
  await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
  expect(h.adminPublish).not.toHaveBeenCalled();
});

it("checks the current profile inside the shared publication lock after signing", async () => {
  const h = setup();
  const owner = await h.open();
  const sign = h.transport.memberAdministration.sign;
  let transferred = false;
  h.transport.memberAdministration.sign = async (template) => {
    const event = await sign(template);
    if (transferred) return event;
    transferred = true;
    h.beforeLock(async () => {
      h.beforeLock(async () => {});
      await h.transferAgent(owner, 0);
    });
    return event;
  };
  const { message } = h.start(owner);
  await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
  expect(h.roles.get(h.agents[0])).toBe("member");
  expect(h.roles.get(h.agents[1])).toBe("admin");
  expect(
    h.adminPublish.mock.calls.some(
      ([event]) => event.tags[1]?.[1] === h.agents[0],
    ),
  ).toBe(false);
});

it("grants an agent whose owner edits its profile during signing", async () => {
  const h = setup();
  const owner = await h.open();
  const sign = h.transport.memberAdministration.sign;
  let edited = false;
  h.transport.memberAdministration.sign = async (template) => {
    const event = await sign(template);
    if (edited) return event;
    edited = true;
    await h.editAgent(owner, 0);
    return event;
  };
  const { message } = h.start(owner);
  await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
  expect(h.agents.map((key) => h.roles.get(key))).toEqual(["admin", "admin"]);
});
