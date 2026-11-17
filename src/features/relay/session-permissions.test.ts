import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { matchesEvent } from "./projection";
import { keypair, message, signed } from "./testing";
import type { RelayEvent } from "./events";
import type { AttachmentUpload } from "./attachments";
import { removeAgentFromChannels } from "../agents/relay-removal";

const id = "11111111-1111-4111-8111-111111111111";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  initialRole = "member",
  uploadAttachment?: AttachmentUpload,
  grants = { replies: false, reactions: false },
) {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair(),
    agent = keypair();
  let role = initialRole,
    peerRole = "owner",
    member = true,
    joinRole = "guest",
    time = 1700000000,
    agentJoined = true;
  const own = message(viewer, id, "Earlier message", time);
  const root = message(peer, id, "Announcement", time);
  const canvas = signed(peer, {
    kind: 40100,
    content: "Saved announcement notes",
    tags: [["h", id]],
    created_at: time,
  });
  const extra: RelayEvent[] = [];
  const events = () => [
    signed(relay, {
      kind: 39000,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ["name", "Updates"],
        ["t", "stream"],
        ["public"],
        ["join_role", joinRole],
        ["guest_replies", String(grants.replies)],
        ["guest_reactions", String(grants.reactions)],
      ],
    }),
    signed(relay, {
      kind: 39001,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ...(peerRole === "owner" ? [["p", peer.pubkey, "owner"]] : []),
      ],
    }),
    signed(relay, {
      kind: 39002,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "", peerRole],
        ...(member ? [["p", viewer.pubkey, "", role]] : []),
        ...(agentJoined ? [["p", agent.pubkey, "", "bot"]] : []),
      ],
    }),
    own,
    root,
    canvas,
    ...extra,
  ];
  const sign = vi.fn(async (event: EventTemplate) => signed(viewer, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9022) {
      member = false;
      time++;
    }
    if (event.kind === 9021) {
      member = true;
      role = joinRole;
      time++;
    }
    if (
      event.kind === 9001 &&
      event.tags.some(([key, value]) => key === "p" && value === agent.pubkey)
    ) {
      agentJoined = false;
      time++;
    }
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: { sign, publish },
      channelLifecycle: { sign, publish },
      channelDetails: { sign, publish },
      workflows: { runs: async () => ({ runs: [], next: null }) },
      ...(uploadAttachment ? { uploadAttachment } : {}),
      query: async (filters) =>
        events().filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.refreshList?.();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await owner.session.read([{ kinds: [9], "#h": [id], limit: 10 }]);
  await owner.session.outbox?.ready();
  return {
    ...owner,
    sign,
    publish,
    own,
    root,
    viewer,
    peer,
    agent,
    async readExtra(event: RelayEvent) {
      extra.push(event);
      await owner.session.read([{ ids: [event.id], limit: 1 }]);
    },
    async grants(next: typeof grants) {
      grants = next;
      time++;
      await owner.session.read([{ kinds: [39000], "#d": [id], limit: 1 }]);
    },
    async role(next: string) {
      role = next;
      time++;
      await owner.session.read([{ kinds: [39002], "#d": [id], limit: 1 }]);
    },
    async peerRole(next: string) {
      peerRole = next;
      time++;
      await owner.session.read([{ kinds: [39002], "#d": [id], limit: 1 }]);
    },
    async default(next: string) {
      joinRole = next;
      time++;
      await owner.session.read([{ kinds: [39000], "#d": [id], limit: 1 }]);
    },
  };
}

it("rejects a guest's direct message operations before signing and restores them only after promotion", async () => {
  const h = await setup("guest");
  for (const action of [
    () => h.session.messages.send(id, "Post"),
    () => h.session.messages.reply(id, h.root.id, "Reply"),
    () => h.session.messages.react(h.root.id, "👍"),
    () => h.session.messages.edit(h.own.id, "Edit", h.own.id),
    () => h.session.messages.remove([h.own.id]),
  ])
    expect(action).toThrow();
  await h.default("member");
  expect(() => h.session.messages.send(id, "Still guest")).toThrow();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  await h.role("member");
  h.session.messages.send(id, "Now member");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
});

it.each([9, 7, 40003, 5, 40100, 30620, 46020])(
  "blocks kind %s sent directly through a guest's outbox",
  async (kind) => {
    const h = await setup("guest");
    const outbox = h.session.outbox;
    assert.exists(outbox);
    const workflow = kind === 30620 || kind === 46020;
    const eventId = outbox.send({
      kind,
      content:
        kind === 30620
          ? "name: Updates\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: send\n    action: send_message\n    text: Hi\n"
          : kind === 46020
            ? ""
            : "Write",
      tags: [["h", id], workflow ? ["d", id] : ["e", h.root.id]],
    });
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((entry) => entry.event.id === eventId),
      ).toMatchObject({
        delivery: "failed",
        error: workflow
          ? "Workflow command rejected; retain the draft and refresh the saved configuration."
          : "You have read-only access to this channel.",
      }),
    );
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it.each([9000, 9022])(
  "leaves Guest membership command %s authorization to the relay",
  async (kind) => {
    const h = await setup("guest");
    const outbox = h.session.outbox;
    assert.exists(outbox);
    const eventId = outbox.send({
      kind,
      content: "",
      tags: [["h", id], ...(kind === 9022 ? [] : [["p", h.peer.pubkey]])],
    });
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((entry) => entry.event.id === eventId),
      ).toMatchObject({ delivery: "accepted" }),
    );
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish.mock.calls[0]?.[0]).toMatchObject({ kind });
  },
);

it("lets a Guest remove an agent through the existing removal workflow and confirm its fresh roster", async () => {
  const h = await setup("guest");
  await removeAgentFromChannels(
    h.session,
    h.agent.pubkey,
    new AbortController().signal,
  );
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9001,
    tags: expect.arrayContaining([
      ["h", id],
      ["p", h.agent.pubkey],
    ]),
  });
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
});

it("blocks a message demoted while signing without publishing it", async () => {
  const h = await setup();
  const started = deferred<void>(),
    gate = deferred<void>();
  h.sign.mockImplementationOnce(async (template) => {
    started.resolve();
    await gate.promise;
    return signed(h.viewer, template);
  });
  const eventId = h.session.messages.send(id, "Queued before demotion");
  try {
    await started.promise;
    await h.role("guest");
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() =>
    expect(
      h.session.outbox?.snapshot().find((entry) => entry.event.id === eventId),
    ).toMatchObject({
      delivery: "failed",
      error: "You have read-only access to this channel.",
    }),
  );
  expect(h.publish).not.toHaveBeenCalled();
});

it("rechecks a signed retry after demotion without signing or publishing it again", async () => {
  const h = await setup();
  h.publish.mockRejectedValueOnce(new PublishRejected("Try later"));
  const eventId = h.session.messages.send(id, "Signed before demotion");
  await vi.waitFor(() =>
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed"),
  );
  await h.role("guest");
  h.session.messages.retry(eventId);
  await vi.waitFor(() =>
    expect(h.session.outbox?.snapshot()[0]).toMatchObject({
      delivery: "failed",
      error: "You have read-only access to this channel.",
    }),
  );
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("publishes a roster owner change that leaves the viewer's own role as it was", async () => {
  const h = await setup("owner");
  const channel = () =>
    h.session.channels.list().channels.find((entry) => entry.id === id);
  expect(channel()?.owners).toEqual([h.peer.pubkey, h.viewer.pubkey].sort());
  // Only the other owner changes: members and the viewer's role stay put, yet
  // the viewer becomes the last owner, which decides whether Leave is offered.
  await h.peerRole("member");
  await vi.waitFor(() => expect(channel()?.owners).toEqual([h.viewer.pubkey]));
  expect(channel()?.viewerRole).toBe("owner");
});

it("retains guest history, details and Leave", async () => {
  const h = await setup("guest");
  expect(
    await h.session.read([{ kinds: [9], "#h": [id], limit: 10 }]),
  ).toHaveLength(2);
  expect(await h.session.channelDetails.load(id)).toMatchObject({
    canEdit: false,
  });
  expect(await h.session.channelLifecycle.load(id)).toMatchObject({
    canLeave: true,
    canArchive: false,
  });
  await h.session.channelLifecycle.run("leave", id);
  expect(h.publish.mock.calls[0]?.[0].kind).toBe(9022);
  expect(h.session.channels.list().channels).toHaveLength(0);
});

it("drops a departed Guest's role when a newer public preview permits rejoining in the same session", async () => {
  const h = await setup("guest");
  await h.session.channelLifecycle.run("leave", id);
  // Advance metadata independently of the equal-version preview regression.
  await h.default("member");
  await h.session.channels.resolve?.([id]);
  const preview = h.session.channels.get?.(id);
  expect(preview).toMatchObject({ readOnly: true, joinRole: "member" });
  expect(preview?.viewerRole).toBeUndefined();
  expect(h.session.channels.list().channels).toHaveLength(0);
  await h.session.channelLifecycle.run("join", id);
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([
    9022, 9021,
  ]);
  expect(h.session.channels.get?.(id)).toMatchObject({ viewerRole: "member" });
  h.session.messages.send(id, "Rejoined participant");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(3));
});

it("lets a Guest read canvas content and history without granting save access", async () => {
  const h = await setup("guest");
  expect(await h.session.canvas.read(id)).toMatchObject({
    content: "Saved announcement notes",
  });
  expect((await h.session.canvas.history(id)).revisions).toHaveLength(1);
  await expect(
    h.session.canvas.save(id, "Forbidden edit", undefined),
  ).rejects.toThrow("Canvas writing is unavailable in this channel");
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("rejects guest uploads and fences an upload completed after demotion", async () => {
  const started = deferred<void>(),
    gate = deferred<void>();
  const result = {
    url: "https://relay.test/media/notes.txt",
    name: "notes.txt",
    size: 4,
    type: "text/plain",
    sha256: "a".repeat(64),
  };
  const upload = vi.fn(async () => {
    started.resolve();
    await gate.promise;
    return result;
  });
  const h = await setup("guest", upload);
  const attachments = h.session.attachments;
  assert.exists(attachments);
  const file = new File(["text"], "notes.txt");
  await expect(
    attachments.upload(file, id, new AbortController().signal),
  ).rejects.toMatchObject({ code: "denied" });
  expect(upload).not.toHaveBeenCalled();
  await h.role("member");
  const pending = attachments.upload(file, id, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "denied" });
  try {
    await started.promise;
    await h.role("guest");
  } finally {
    gate.resolve();
  }
  await rejected;
});

it.each([
  { replies: false, reactions: false },
  { replies: true, reactions: false },
  { replies: false, reactions: true },
  { replies: true, reactions: true },
])("grants only the opted-in Guest contributions: %j", async (grants) => {
  const h = await setup("guest", undefined, grants);
  expect(() => h.session.messages.send(id, "Root remains forbidden")).toThrow();
  const reply = () =>
    h.session.messages.reply(id, h.root.id, "Reply with mention", [
      h.peer.pubkey,
    ]);
  const react = () => h.session.messages.react(h.root.id, "👍");
  const accepted: string[] = [];
  if (grants.replies) accepted.push(reply());
  else expect(reply).toThrow();
  if (grants.reactions) accepted.push(react());
  else expect(react).toThrow();
  await vi.waitFor(() => {
    for (const eventId of accepted)
      expect(
        h.session.outbox?.snapshot().find((item) => item.event.id === eventId)
          ?.delivery,
      ).toBe("accepted");
  });
  if (!grants.replies || !grants.reactions) {
    expect(h.publish).toHaveBeenCalledTimes(accepted.length);
    return;
  }
  const outbox = h.session.outbox;
  assert(outbox);
  for (const tags of [
    [
      ["h", id],
      ["e", h.root.id, "", "root"],
    ],
    [
      ["h", id],
      ["e", h.root.id, "", "reply"],
      ["broadcast", "1"],
    ],
  ]) {
    const eventId = outbox.send({
      kind: 9,
      content: "Forbidden root or broadcast",
      tags,
    });
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((item) => item.event.id === eventId)?.delivery,
      ).toBe("failed"),
    );
  }
  expect(h.publish).toHaveBeenCalledTimes(accepted.length);
});

it("revokes a Guest reply while signing and rechecks its signed retry", async () => {
  const h = await setup("guest", undefined, {
    replies: true,
    reactions: false,
  });
  const started = deferred<void>(),
    gate = deferred<void>();
  h.sign.mockImplementationOnce(async (template) => {
    started.resolve();
    await gate.promise;
    return signed(h.viewer, template);
  });
  const eventId = h.session.messages.reply(
    id,
    h.root.id,
    "Draft before revocation",
  );
  try {
    await started.promise;
    await h.grants({ replies: false, reactions: false });
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() =>
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === eventId)
        ?.delivery,
    ).toBe("failed"),
  );
  h.session.messages.retry(eventId);
  await vi.waitFor(() =>
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === eventId)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(h.publish).not.toHaveBeenCalled();
});

it("lets a Guest manage its reply and remove its reaction after additions are disabled", async () => {
  const h = await setup("guest", undefined, { replies: true, reactions: true });
  const reply = h.session.messages.reply(id, h.root.id, "My reply");
  const reaction = h.session.messages.react(h.root.id, "👍");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  h.session.messages.edit(reply, "Edited reply", reply);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(3));
  await h.grants({ replies: true, reactions: false });
  h.session.messages.remove([reaction]);
  h.session.messages.remove([reply]);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(5));
  expect(() => h.session.messages.remove([h.own.id])).toThrow();
});

it("allows reply attachments and rejects an upload finishing after its grant is revoked", async () => {
  const started = deferred<void>(),
    gate = deferred<void>();
  const result = {
    url: "https://relay.test/media/notes.txt",
    name: "notes.txt",
    size: 4,
    type: "text/plain",
    sha256: "a".repeat(64),
  };
  const upload = vi.fn(async () => {
    started.resolve();
    await gate.promise;
    return result;
  });
  const h = await setup("guest", upload, { replies: true, reactions: false });
  const attachments = h.session.attachments;
  assert.exists(attachments);
  const pending = attachments.upload(
    new File(["text"], "notes.txt"),
    id,
    new AbortController().signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "denied" });
  try {
    await started.promise;
    await h.grants({ replies: false, reactions: true });
  } finally {
    gate.resolve();
  }
  await rejected;
  expect(upload).toHaveBeenCalledOnce();
  await h.grants({ replies: true, reactions: false });
  await expect(
    attachments.upload(
      new File(["text"], "notes.txt"),
      id,
      new AbortController().signal,
    ),
  ).resolves.toEqual(result);
});

it("removes an old reaction by its last valid target after demotion", async () => {
  const h = await setup("member");
  const outbox = h.session.outbox;
  assert.exists(outbox);
  const context = signed(h.peer, {
    kind: 0,
    content: "{}",
    tags: [],
    created_at: 1700000000,
  });
  await h.readExtra(context);
  const reaction = outbox.send({
    kind: 7,
    content: "👍",
    tags: [
      ["e", context.id],
      ["e", h.root.id],
    ],
  });
  await vi.waitFor(() =>
    expect(
      outbox.snapshot().find((item) => item.event.id === reaction)?.delivery,
    ).toBe("accepted"),
  );
  await h.role("guest");
  h.session.messages.remove([reaction]);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  expect(h.publish.mock.calls[1]?.[0]).toMatchObject({
    kind: 5,
    tags: expect.arrayContaining([
      ["h", id],
      ["e", reaction],
    ]),
  });
});
