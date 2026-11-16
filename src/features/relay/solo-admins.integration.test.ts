import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, metadata, signed } from "./testing";
import { matchesEvent } from "./projection";
import { SOLO_LABEL } from "../solo/labels";
import { soloAdminKey } from "./solo-admins";
import { validateMemberAdministrationTemplate } from "../channel-members/administration-protocol";
import type { OutgoingEvent } from "./outbox";
import type { ReadFilter, RelayEvent } from "./events";
import type { EventTemplate } from "nostr-tools";

const sessions: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function setup() {
  const viewer = keypair(),
    relay = keypair();
  const channel = crypto.randomUUID();
  const agents: [string, string] = [keypair().pubkey, keypair().pubkey];
  const workspaceAgent = keypair().pubkey;
  let journal: readonly OutgoingEvent[] = [];
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
      const roster = signed(relay, {
        kind: 39002,
        content: "",
        tags: [
          ["d", channel],
          ...[...roles].map(([key, role]) => ["p", key, "", role]),
        ],
      });
      return [
        ...events.values(),
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
        load: () => structuredClone(journal),
        save: (next) => {
          journal = structuredClone(next);
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
      { admins: agents },
    );
    void creation.ready.catch(() => {});
    const message = owner.session.messages.send(
      channel,
      "Work on this",
      agents,
    );
    return { creation, message };
  };
  return {
    channel,
    viewer,
    agents,
    workspaceAgent,
    roles,
    events,
    genericPublish,
    adminPublish,
    open,
    start,
  };
}

it("holds the opening message and local wake until all admins are ready through the existing host route", async () => {
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
  h.adminPublish.mockImplementation(async (event) => {
    await held;
    await publish(event);
  });
  try {
    const { message } = h.start(owner);
    await vi.waitFor(() => expect(h.adminPublish).toHaveBeenCalledOnce());
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
    expect(h.roles.get(h.workspaceAgent)).toBe("member");
    expect(h.roles.get(h.viewer.pubkey)).toBe("owner");
    expect(h.adminPublish).toHaveBeenCalledTimes(2);
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
