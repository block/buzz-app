import { afterEach, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createRelaySession } from "./session";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler } from "./profiling";
import { foldMessages } from "./fold";
import { PublishRejected } from "./outbox";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const root = message(other, "c", "React here", 1);
const reaction = (author = viewer, time = 2) =>
  signed(author, {
    kind: 7,
    content: "👍",
    created_at: time,
    tags: [
      ["e", root.id],
      ["h", "c"],
    ],
  });
const remove = (target: RelayEvent, author = viewer) =>
  signed(author, {
    kind: 5,
    content: "",
    tags: [
      ["e", target.id],
      ["h", "c"],
      ["k", "7"],
    ],
  });
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("groups by event-local emoji identity, counts unique people and retains duplicate event IDs", () => {
  const mine = reaction(),
    duplicate = reaction(viewer, 3),
    theirs = reaction(other);
  const custom = (url: string) =>
    signed(viewer, {
      kind: 7,
      content: ":party:",
      tags: [
        ["e", root.id],
        ["emoji", "party", url],
      ],
    });
  const rows = foldMessages("c", relay.pubkey, [
    root,
    mine,
    duplicate,
    theirs,
    custom("https://one.test/a"),
    custom("https://two.test/a"),
  ]);
  expect(rows[0]?.reactions).toHaveLength(3);
  expect(rows[0]?.reactions[0]?.events).toEqual([
    { id: mine.id, authorId: viewer.pubkey },
    { id: duplicate.id, authorId: viewer.pubkey },
    { id: theirs.id, authorId: other.pubkey },
  ]);
  expect(
    new Set(rows[0]?.reactions[0]?.events.map((item) => item.authorId)).size,
  ).toBe(2);
});

it("incremental channel projection applies delete-of-reaction and rolls back a failed deletion", () => {
  const mine = reaction(),
    deletion = remove(mine);
  const projection = new MessageProjection(
    "c",
    relay.pubkey,
    createRelayProfiler(),
  );
  expect(projection.reconcile([root, mine], [])[0]?.reactions).toHaveLength(1);
  expect(
    projection.reconcile([root, mine, remove(mine, other)], [])[0]?.reactions,
  ).toHaveLength(1);
  expect(
    projection.reconcile([root, mine, deletion], [])[0]?.reactions,
  ).toEqual([]);
  expect(projection.reconcile([root, mine], [])[0]?.reactions).toHaveLength(1);
  expect(
    projection.reconcile([root, deletion, mine], [])[0]?.reactions,
  ).toEqual([]);
});

it("removal validates every loaded author and conversation before queuing one deletion", () => {
  const mine = reaction(),
    duplicate = reaction(viewer, 3),
    theirs = reaction(other);
  const foreign = message(viewer, "other", "own message", 2);
  const events = [root, mine, duplicate, theirs, foreign];
  const send = vi.fn(() => "operation");
  const messages = createMessages(
    {
      supports: () => true,
      send,
      retry() {},
      dismiss: async () => {},
      snapshot: () => [],
      subscribe: () => () => {},
      observeSend: () => () => {},
    },
    viewer.pubkey,
    (id) => events.find((item) => item.id === id),
    () => [],
    () => {},
  );
  expect(() => messages.remove([mine.id, theirs.id])).toThrow(/Only your own/);
  expect(() => messages.remove([mine.id, foreign.id])).toThrow(
    /one loaded conversation/,
  );
  expect(() => messages.remove(["missing"])).toThrow(/Load/);
  expect(send).not.toHaveBeenCalled();
  messages.remove([mine.id, duplicate.id, mine.id]);
  expect(send).toHaveBeenCalledExactlyOnceWith({
    kind: 5,
    content: "",
    tags: [
      ["h", "c"],
      ["e", mine.id],
      ["e", duplicate.id],
      ["k", "7"],
    ],
  });
});

it("real session retries the same signed deletion and keeps the reaction removed after confirmation", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("try again");
  });
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  const mine = reaction();
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root, mine]);
  const id = owner.session.messages.remove([mine.id]);
  expect(owner.session.channels.window("c").rows[0]?.reactions).toEqual([]);
  await flush();
  await flush();
  expect(owner.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  expect(owner.session.channels.window("c").rows[0]?.reactions).toHaveLength(1);
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  owner.session.messages.retry(id);
  await flush();
  await flush();
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
  if (!original) throw new Error("Missing signed deletion");
  live.receive([original]);
  expect(owner.session.channels.window("c").rows[0]?.reactions).toEqual([]);
  live.receive([mine]);
  expect(owner.session.channels.window("c").rows[0]?.reactions).toEqual([]);
});
