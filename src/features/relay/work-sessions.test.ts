import { expect, it, vi } from "vitest";
import { SESSION_CHANNEL_DESCRIPTION } from "../sessions/metadata";
import { createWorkSessions } from "./work-sessions";
import type { Outbox, OutgoingEvent } from "./outbox";
import type { ChannelQueries } from "./contracts";
import {
  keypair,
  message,
  roster,
  flush,
  scriptedTransport,
  signed,
} from "./testing";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
const event = message(keypair(), "session", "Work", 1);

it("restores an unconfirmed ordinary channel without creating a second identity", async () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const creation = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Updates for the team"],
      ["ttl", "604800"],
    ],
  });
  const sessionCreation = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", "22222222-2222-4222-8222-222222222222"],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", SESSION_CHANNEL_DESCRIPTION],
    ],
  });
  let records: readonly OutgoingEvent[] = [
    { event: creation, signed: creation, delivery: "unknown" },
    {
      event: sessionCreation,
      signed: sessionCreation,
      delivery: "accepted",
    },
  ];
  const sign = vi.fn(async () => creation);
  const publish = vi.fn(async () => {
    throw new Error("acknowledgement lost");
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      writer: { kinds: [9, 9000, 9007], sign, publish },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    await vi.waitFor(() =>
      expect(owner.session.channelCreation.snapshot()).toEqual({
        name: "Release notes",
        description: "Updates for the team",
        visibility: "private",
        ttlSeconds: 604800,
      }),
    );
    await expect(
      owner.session.channelCreation.create({
        name: "Different",
        visibility: "open",
      }),
    ).rejects.toThrow(/still awaiting confirmation/);
    await expect(
      owner.session.channelCreation.create({
        name: "Release notes",
        description: "Updates for the team",
        visibility: "private",
        ttlSeconds: 604800,
      }),
    ).rejects.toThrow(/acknowledgement lost/);
    expect(sign).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(
      owner.session.outbox
        ?.snapshot()
        .filter((item) => item.event.id === creation.id),
    ).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});

it("retains a seen channel creation while creator membership is unconfirmed", async () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const creation = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
    ],
  });
  let records: readonly OutgoingEvent[] = [
    { event: creation, signed: creation, delivery: "seen" },
  ];
  const sign = vi.fn(async () => creation);
  const publish = vi.fn(async () => {});
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { kinds: [9, 9000, 9007], sign, publish },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  const input = { name: "Release notes", visibility: "open" as const };
  try {
    await vi.waitFor(() =>
      expect(owner.session.channelCreation.snapshot()).toEqual(input),
    );
    const creating = owner.session.channelCreation.create(input);
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    const publicMetadata = signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "Release notes" }),
      tags: [["d", id], ["name", "Release notes"], ["public"]],
    });
    wire.next().respond([publicMetadata]);
    await vi.waitFor(() =>
      expect(owner.session.channels.get?.(id)?.readOnly).toBe(true),
    );
    expect(sign).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(owner.session.channelCreation.snapshot()).toEqual(input);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ id: creation.id }),
        delivery: "seen",
      }),
    );

    owner.session.channels.refreshList?.();
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    wire.next().respond([roster(relay, id, [viewer.pubkey]), publicMetadata]);
    await expect(creating).resolves.toBe(id);
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.id === creation.id)).toBe(false),
    );
    expect(owner.session.channelCreation.snapshot()).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it("removes a successfully refreshed channel creation from durable recovery", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let records: readonly OutgoingEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    const creating = owner.session.channelCreation.create({
      name: "Release notes",
      visibility: "open",
    });
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
    );
    const id = records
      .find(({ event }) => event.kind === 9007)
      ?.event.tags.find(([name]) => name === "h")?.[1];
    expect(id).toBeTypeOf("string");
    const publicMetadata = signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "Release notes" }),
      tags: [["d", id ?? ""], ["name", "Release notes"], ["public"]],
    });
    await vi.waitFor(() => expect(wire.pending).toHaveLength(2));
    for (const request of [wire.next(), wire.next()])
      request.respond([publicMetadata]);
    await vi.waitFor(() =>
      expect(owner.session.channels.get?.(id ?? "")?.readOnly).toBe(true),
    );
    let resolved = false;
    void creating.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    expect(records.some(({ event }) => event.kind === 9007)).toBe(true);

    owner.session.channels.refreshList?.();
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    wire
      .next()
      .respond([roster(relay, id ?? "", [viewer.pubkey]), publicMetadata]);
    await expect(creating).resolves.toBe(id);
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(false),
    );
    expect(owner.session.channelCreation.snapshot()).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it.each([true, false])(
  "confirms an exact own creation without admitting a channel missing its roster (receipt: %s)",
  async (found) => {
    const viewer = keypair(),
      relay = keypair();
    const channelId = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [["h", channelId]],
    });
    const publish = vi.fn(async () => {
      throw new PublishRejected("duplicate: channel already exists");
    });
    const query = vi.fn(async (filters: Parameters<RelaySessionRead>[0]) =>
      found && filters.some((filter) => filter.ids?.includes(creation.id))
        ? [creation]
        : [],
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        writer: {
          kinds: [9, 9000, 9007],
          sign: async (template) => signed(viewer, template),
          publish,
        },
      },
      {
        outboxStorage: {
          load: () => [
            { event: creation, signed: creation, delivery: "unknown" },
          ],
          save: () => {},
        },
      },
    );
    try {
      owner.session.channels.ensureList?.();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      if (found) {
        await owner.session.workSessions.delivered(creation.id);
        expect(publish).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledWith(
          [
            {
              kinds: [9007],
              ids: [creation.id],
              authors: [viewer.pubkey],
              limit: 1,
            },
          ],
          expect.anything(),
          expect.anything(),
          expect.anything(),
        );
      } else {
        await expect(
          owner.session.workSessions.delivered(creation.id),
        ).rejects.toThrow(/duplicate/);
      }
      expect(owner.session.channels.list().channels).toHaveLength(0);
      expect(() =>
        owner.session.messages.send(channelId, "Work", [viewer.pubkey]),
      ).toThrow();
    } finally {
      owner.dispose();
    }
  },
);
type RelaySessionRead = ReturnType<
  typeof createRelaySession
>["session"]["read"];
function setup(
  channelCreation = true,
  channelList: ReturnType<ChannelQueries["list"]> = {
    status: "ready",
    channels: [],
  },
) {
  let items: readonly OutgoingEvent[] = [{ event, delivery: "accepted" }];
  const listeners = new Set<() => void>();
  const receipts = {
    snapshot: () => items,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const outbox: Outbox = {
    observeSend: () => () => {},
    snapshot: () => [],
    subscribe: receipts.subscribe,
    supports: (kind) => channelCreation && [9, 9000, 9007].includes(kind),
    send: vi.fn(() => event.id),
    retry: vi.fn(() => {
      items = [{ event, delivery: "accepted" }];
      for (const fn of listeners) fn();
    }),
    dismiss: vi.fn(async () => {}),
  };
  const channels = {
    list: () => channelList,
    subscribeList: () => () => {},
    refreshList: vi.fn(),
  } as unknown as ChannelQueries;
  const reader = { read: vi.fn(async () => [event]) };
  const controller = new AbortController();
  return {
    service: createWorkSessions(
      outbox,
      channels,
      reader,
      controller.signal,
      receipts,
    ),
    outbox,
    channels,
    reader,
    listeners,
    controller,
    setItems: (next: readonly OutgoingEvent[]) => {
      items = next;
    },
  };
}
it("confirms completed journal receipts after they leave the pending outbox", async () => {
  const test = setup();
  await test.service.delivered(event.id);
  expect(test.reader.read).not.toHaveBeenCalled();
  expect(test.listeners.size).toBe(0);
});
it("accepts already-applied creator membership without a refresh notification", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const member = "a".repeat(64);
  const test = setup(true, {
    status: "ready",
    channels: [{ id, name: "Release notes", members: [member] }],
  });
  await expect(
    test.service.refresh(id, { member }, false),
  ).resolves.toBeUndefined();
  expect(test.channels.refreshList).toHaveBeenCalledOnce();
});
it("retries the same unknown event and confirms restored receipts through verified reads", async () => {
  const test = setup();
  test.setItems([{ event, delivery: "unknown" }]);
  await test.service.delivered(event.id);
  expect(test.outbox.retry).toHaveBeenCalledWith(event.id);
  test.setItems([]);
  await test.service.delivered(event.id);
  expect(test.reader.read).toHaveBeenCalled();
});
it("fails closed when capability is absent or connection ends", async () => {
  const unsupported = setup(false);
  expect(unsupported.service.available).toBe(false);
  expect(() =>
    unsupported.service.create("11111111-1111-4111-8111-111111111111", "Work"),
  ).toThrow(/does not support/);
  const test = setup();
  test.setItems([{ event, delivery: "sending" }]);
  const pending = test.service.delivered(event.id);
  test.controller.abort();
  await expect(pending).rejects.toThrow(/connection changed/);
  expect(test.listeners.size).toBe(0);
});

it("permits editing only after a definitive rejection, never an uncertain send", async () => {
  const test = setup();
  test.setItems([{ event, delivery: "unknown" }]);
  expect(test.service.failed(event.id)).toBe(false);
  await expect(test.service.discardFailed(event.id)).rejects.toThrow(
    /unconfirmed/,
  );
  expect(test.outbox.dismiss).not.toHaveBeenCalled();
  test.setItems([{ event, delivery: "failed" }]);
  expect(test.service.failed(event.id)).toBe(true);
  await test.service.discardFailed(event.id);
  expect(test.outbox.dismiss).toHaveBeenCalledWith(event.id);
});

it("starts a standalone session using existing private-channel creation without the Sessions extension", () => {
  const test = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  expect(test.service.available).toBe(true);
  test.service.create(id, "Work");
  expect(test.outbox.send).toHaveBeenCalledWith({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
    ],
  });
  const parent = "22222222-2222-4222-8222-222222222222";
  test.service.create(id, "Child", parent);
  expect(test.outbox.send).toHaveBeenLastCalledWith({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Child"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", `${SESSION_CHANNEL_DESCRIPTION}\nparent:${parent}`],
    ],
  });
  expect(() => test.service.create(id, "Child", id)).toThrow(/own parent/);
  expect(test.outbox.send).toHaveBeenCalledTimes(2);
});

it("creates an ordinary stream with explicit visibility and optional description", () => {
  const test = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  test.service.createChannel(id, "  Release notes  ", "open", "  Updates  ");
  expect(test.outbox.send).toHaveBeenCalledWith({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
      ["about", "Updates"],
    ],
  });
  test.service.createChannel(id, "Private", "private");
  expect(test.outbox.send).toHaveBeenLastCalledWith({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Private"],
      ["visibility", "private"],
      ["channel_type", "stream"],
    ],
  });
  test.service.createChannel(id, "Standup", "open", undefined, 604800);
  expect(test.outbox.send).toHaveBeenLastCalledWith({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Standup"],
      ["visibility", "open"],
      ["channel_type", "stream"],
      ["ttl", "604800"],
    ],
  });
  for (const description of [
    SESSION_CHANNEL_DESCRIPTION,
    "Buzz session (notes)",
  ]) {
    expect(() =>
      test.service.createChannel(id, "Not a session", "private", description),
    ).toThrow(/different channel description/);
  }
  expect(test.outbox.send).toHaveBeenCalledTimes(3);
  expect(() => test.service.createChannel(id, " ", "open")).toThrow(/name/);
  expect(() =>
    test.service.createChannel(id, "Work", "open", "x".repeat(1001)),
  ).toThrow(/description/);
  expect(() =>
    test.service.createChannel(id, "Work", "open", undefined, 0),
  ).toThrow(/duration/);
});

it("recovers a lost normal-channel creation acknowledgment only with its exact verified event", async () => {
  const test = setup();
  const creation = signed(keypair(), {
    kind: 9007,
    content: "",
    tags: [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", SESSION_CHANNEL_DESCRIPTION],
    ],
  });
  test.setItems([{ event: creation, delivery: "unknown" }]);
  test.reader.read.mockResolvedValueOnce([creation]);
  await test.service.delivered(creation.id);
  expect(test.outbox.retry).not.toHaveBeenCalled();
  expect(test.reader.read).toHaveBeenCalledWith(
    [
      {
        kinds: [39000, 39002],
        "#d": ["11111111-1111-4111-8111-111111111111"],
        limit: 2,
      },
      { ids: [creation.id], limit: 1 },
    ],
    expect.anything(),
  );
});

it.each([true, false])(
  "checks fresh roster access before recovering creation (member: %s)",
  async (member) => {
    const viewer = keypair(),
      relay = keypair();
    const channelId = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [["h", channelId]],
    });
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) =>
        filters.some((filter) => filter.ids)
          ? [creation, roster(relay, channelId, member ? [viewer.pubkey] : [])]
          : [],
    });
    try {
      owner.session.channels.ensureList?.();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      let items: readonly OutgoingEvent[] = [
        { event: creation, delivery: "unknown" },
      ];
      const outbox: Outbox = {
        observeSend: () => () => {},
        supports: () => true,
        send: vi.fn(),
        snapshot: () => items,
        subscribe: () => () => {},
        retry: vi.fn(() => {
          items = [{ event: creation, delivery: "failed" }];
        }),
        dismiss: async () => {},
      };
      const service = createWorkSessions(
        outbox,
        owner.session.channels,
        {
          read: async (filters, options) => {
            const visible = await owner.session.read(filters, options);
            return visible.some((event) => event.id === creation.id)
              ? [creation]
              : [];
          },
        },
        new AbortController().signal,
      );
      if (member) {
        await service.delivered(creation.id);
        expect(outbox.retry).not.toHaveBeenCalled();
      } else {
        await expect(service.delivered(creation.id)).rejects.toThrow(
          /could not be confirmed/,
        );
        expect(outbox.retry).toHaveBeenCalledWith(creation.id);
      }
    } finally {
      owner.dispose();
    }
  },
);
