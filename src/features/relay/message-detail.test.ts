import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "./session";
import { DETAIL_READ_LIMIT } from "./message-detail";
import { ReadError } from "./errors";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const root = message(alice, "a", "Old original", 1);
const reply = message(alice, "a", "Selected nested reply", 10000, [
  ["e", root.id, "", "root"],
  ["e", "b".repeat(64), "", "reply"],
]);
const aux = (kind: number, target: RelayEvent, content = "", time = 10001) =>
  signed(alice, { kind, content, created_at: time, tags: [["e", target.id]] });
function setup(id = root.id) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return {
    ...wire,
    ...owner,
    traffic,
    view: owner.session.messageDetail("a", id),
  };
}

it("locates an old nested reply in three bounded reads without head insertion or traversal", async () => {
  const h = setup(reply.id);
  h.traffic.receive([roster(relay, "a", [viewer.pubkey])]);
  h.session.channels.ensure("a");
  const head = message(alice, "a", "Head", 20000);
  h.next().respond([
    head,
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  // Optional head profile fetch must not stand in for any detail request.
  for (const pending of h.pending.splice(0)) pending.respond([]);
  const before = h.session.channels.window("a");
  const loading = h.view.refresh();
  const selected = h.next();
  expect(selected.filters).toEqual([
    { ids: [reply.id], "#h": ["a"], limit: 1 },
  ]);
  selected.respond([reply]);
  await flush();
  const edit = aux(40003, reply, "Edited selected reply");
  const reaction = aux(7, reply, "+");
  const direct = h.next();
  expect(direct.filters[0]).toMatchObject({
    kinds: [39005, 40003, 5, 7, 9005],
    limit: 500,
  });
  expect(direct.filters[0]?.["#h"]).toBeUndefined();
  expect([...(direct.filters[0]?.["#e"] ?? [])].sort()).toEqual([reply.id]);
  direct.respond([edit, reaction]);
  await flush();
  const deletion = h.next();
  expect(deletion.filters[0]?.kinds).toEqual([5, 9005]);
  expect([...(deletion.filters[0]?.["#e"] ?? [])].sort()).toEqual(
    [edit.id, reaction.id].sort(),
  );
  deletion.respond([aux(5, reaction)]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    target: { id: reply.id, content: "Edited selected reply", reactions: [] },
  });
  expect(h.session.channels.window("a").rows).toEqual(before.rows);
  expect(h.session.channels.window("a").rows.map((row) => row.id)).toEqual([
    head.id,
  ]);
  expect(h.pending).toHaveLength(0);
});

it("folds author deletes of edits and target deletes, and retains tombstones across refresh omission", async () => {
  const h = setup();
  const loading = h.view.refresh();
  h.next().respond([root]);
  await flush();
  const edit = aux(40003, root, "Edited");
  h.next().respond([edit]);
  await flush();
  h.next().respond([aux(9005, edit)]);
  await loading;
  expect(h.view.snapshot().target?.content).toBe(root.content);
  h.traffic.receive([aux(5, root)]);
  expect(h.view.snapshot()).toMatchObject({
    status: "unavailable",
    target: undefined,
  });
  const retry = h.view.refresh();
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([]);
  await retry;
  expect(h.view.snapshot()).toMatchObject({
    status: "unavailable",
    target: undefined,
  });
});

it("distinguishes missing from failed reads and supports a fresh retry", async () => {
  const h = setup();
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot().status).toBe("unavailable");
  const failed = h.view.refresh();
  h.next().fail(new Error("network down"));
  await failed;
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    error: expect.stringContaining("network down"),
  });
  const retry = h.view.refresh();
  await flush(); // The shared reader yields to the host after a failed fetch.
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  await retry;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    target: { id: root.id },
  });
});

it("opens a verified reply without fetching or substituting its original", async () => {
  const h = setup(reply.id);
  const reading = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  const overlays = h.next();
  expect(overlays.filters[0]?.ids).toBeUndefined();
  expect(overlays.filters[0]?.["#e"]).toEqual([reply.id]);
  overlays.respond([]);
  await reading;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    target: { id: reply.id },
  });
});

it("rejects a capped raw auxiliary response before visibility filtering can hide overflow", async () => {
  const h = setup();
  const reading = h.view.refresh();
  h.next().respond([root]);
  await flush();
  const other = message(alice, "private", "Unavailable target", 2);
  h.next().respond(
    Array.from({ length: DETAIL_READ_LIMIT }, (_, i) => aux(7, other, `${i}`)),
  );
  await reading;
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    limited: true,
    target: undefined,
  });
});

it("retains owned evidence after shared cache eviction, including deletion of an edit", async () => {
  const h = setup();
  const reading = h.view.refresh();
  h.next().respond([root]);
  await flush();
  const edit = aux(40003, root, "Edited");
  h.next().respond([edit]);
  await flush();
  h.next().respond([]);
  await reading;
  // Unrelated signed payloads exceed recent’s 8 MiB byte budget.
  h.traffic.receive(
    Array.from({ length: 140 }, (_, i) =>
      message(alice, "b", `unrelated ${i} ${"x".repeat(65536)}`, i + 20),
    ),
  );
  h.traffic.receive([aux(5, edit)]);
  expect(h.view.snapshot().target?.content).toBe(root.content);
});

it("purges atomically on signed membership loss and fences late results", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 10)]);
  const reading = h.view.refresh();
  h.next().respond([root]);
  await flush();
  const late = h.next();
  h.traffic.receive([roster(relay, "a", [], 11)]);
  expect(late.signal?.aborted).toBe(true);
  expect(h.view.snapshot().target).toBeUndefined();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 12)]);
  late.respond([]);
  await reading;
  expect(h.view.snapshot().target).toBeUndefined();
  const retry = h.view.refresh();
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  await retry;
  expect(h.view.snapshot().target?.id).toBe(root.id);
  h.traffic.receive([roster(relay, "a", [], 13)]);
  expect(h.view.snapshot().target).toBeUndefined();
});

it("a denied reference-only detail read revokes the owning channel, not just its panel", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey]), root]);
  const reading = h.view.refresh();
  h.next().respond([root]);
  await flush();
  h.next().fail(new ReadError("denied", "denied"));
  await reading;
  expect(h.view.snapshot().target).toBeUndefined();
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === "a"),
  ).toBeUndefined();
  const retry = h.view.refresh();
  await retry;
  expect(h.pending).toHaveLength(0);
});

it("shares the 64-view budget and disposes pending requests and cache-cleared evidence", async () => {
  const h = setup();
  const reading = h.view.refresh();
  const pending = h.next();
  h.view.dispose();
  expect(pending.signal?.aborted).toBe(true);
  pending.respond([root]);
  await reading;
  expect(h.view.snapshot().target).toBeUndefined();
  for (let i = 0; i < 63; i++) h.session.thread("a", root.id);
  const last = h.session.messageDetail("a", root.id);
  expect(() => h.session.observe([{ kinds: [9], limit: 1 }])).toThrow(
    "capacity",
  );
  last.dispose();
  const fresh = h.session.messageDetail("a", root.id);
  const load = fresh.refresh();
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  await load;
  await h.clearCache();
  expect(fresh.snapshot().target).toBeUndefined();
});

it("retains already observed tombstones when a later finite detail read omits them", async () => {
  const h = setup();
  h.view.dispose();
  h.traffic.receive([root, aux(5, root)]);
  const view = h.session.messageDetail("a", root.id);
  const reading = view.refresh();
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([]);
  await reading;
  expect(view.snapshot()).toMatchObject({
    status: "unavailable",
    target: undefined,
  });
});

it("repairs through channel establishment without channel-head invalidation cancelling exact reads", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey])]);
  const first = h.view.refresh();
  h.next().respond([root]);
  await flush();
  h.next().respond([]);
  await first;
  h.traffic.established("a");
  const target = h.next();
  expect(target.filters[0]?.ids).toEqual([root.id]);
  await flush();
  expect(target.signal?.aborted).toBe(false);
  target.respond([root]);
  await flush();
  h.next().respond([]);
  await flush();
  expect(h.view.snapshot().status).toBe("ready");
});
