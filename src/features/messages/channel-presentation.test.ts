import { profileTarget } from "../profiles/target";
import { expect, it } from "vitest";
import { createChannelPresentation } from "./channel-presentation";

import { row, fixture } from "./channel-presentation.testing";
const open = (f: ReturnType<typeof fixture>, chat = false) =>
  createChannelPresentation(f.session, "room", { chat, viewer: "viewer" });

it("publishes current edit/reaction/delivery facts by key while order and unrelated rows stay unchanged", () => {
  const a = row("first"),
    b = row("second", { authorId: "b" }),
    c = row("third");
  const f = fixture([a, b, c]),
    owner = open(f);
  const seen: string[] = [];
  const stops = [
    owner.subscribeView(() => {}),
    ...[a, b, c].map((r) => owner.subscribeRow(r.id, () => seen.push(r.id))),
  ];
  const oldA = owner.row(a.id),
    oldC = owner.row(c.id),
    ids = owner.view().ids,
    header = owner.header();
  const edited = row(b.id, { ...b, content: "edited" });
  f.publish([a, edited, c]);
  expect(seen).toEqual([b.id]);
  expect(owner.row(b.id)?.row.content).toBe("edited");
  expect(owner.row(a.id)).toBe(oldA);
  expect(owner.row(c.id)).toBe(oldC);
  expect(owner.view().ids).toBe(ids);
  expect(owner.header()).toBe(header);
  seen.length = 0;
  const reacted = row(b.id, {
    ...edited,
    reactions: [{ content: "👍", events: [{ id: "reaction", authorId: "a" }] }],
  });
  f.publish([a, reacted, c]);
  expect(seen).toEqual([b.id]);
  expect(owner.row(b.id)?.row.reactions[0]?.content).toBe("👍");
  seen.length = 0;
  f.publish([
    a,
    row(b.id, { ...reacted, delivery: "failed", deliveryError: "not sent" }),
    c,
  ]);
  expect(seen).toEqual([b.id]);
  expect(owner.row(b.id)?.row.deliveryError).toBe("not sent");
  for (const stop of stops) stop();
});

it("updates the actual profile, mention and name dependents without invalidating unrelated rows", () => {
  const a = row("alice"),
    b = row("bob", { authorId: "b" }),
    mention = row("mention", {
      authorId: "b",
      mentions: ["a"],
      content: "@Alice",
    });
  const f = fixture([a, b, mention]),
    owner = open(f);
  const seen: string[] = [];
  const stops = [
    owner.subscribeView(() => {}),
    ...[a, b, mention].map((r) =>
      owner.subscribeRow(r.id, () => seen.push(r.id)),
    ),
  ];
  const namesA = owner.names(["a"]),
    namesB = owner.names(["b"]);
  let changedA = 0,
    changedB = 0;
  stops.push(
    namesA.subscribe(() => changedA++),
    namesB.subscribe(() => changedB++),
  );
  const oldB = owner.row(b.id),
    oldNames = namesA.snapshot();
  f.profile("a", { name: "Alice replaced", picture: "new.png", isAgent: true });
  expect(new Set(seen)).toEqual(new Set([a.id, mention.id]));
  expect(owner.row(b.id)).toBe(oldB);
  expect(owner.row(a.id)?.profiles.get("a")?.picture).toBe("new.png");
  expect(owner.row(a.id)?.agentPubkeys.has("a")).toBe(true);
  expect(namesA.snapshot().get("a")).toBe("Alice replaced");
  expect(changedA).toBe(1);
  expect(changedB).toBe(0);
  expect(oldNames.get("a")).toBe("Alice");
  for (const stop of stops) stop();
});

it("publishes an entire generation before any row/order/name notification", () => {
  const a = row("a"),
    b = row("b");
  const f = fixture([a, b]),
    owner = open(f);
  const observations: string[][] = [];
  const observe = () =>
    observations.push([
      owner.row("a")?.row.content ?? "",
      owner.row("b")?.row.content ?? "",
      ...owner.view().ids,
    ]);
  const stops = [
    owner.subscribeView(observe),
    owner.subscribeRow("a", observe),
    owner.subscribeRow("b", observe),
  ];
  f.publish([row("a", { content: "new a" }), row("b", { content: "new b" })]);
  expect(observations.length).toBeGreaterThan(0);
  expect(
    observations.every(
      (x) => JSON.stringify(x) === JSON.stringify(["new a", "new b", "a", "b"]),
    ),
  ).toBe(true);
  for (const stop of stops) stop();
});

it("prepends IDs and recomputes exact sender/day boundaries without remaking unrelated row facts", () => {
  const a = row("a", { createdAt: 200 }),
    b = row("b", { authorId: "b", createdAt: 230 });
  const f = fixture([a, b]),
    owner = open(f);
  const stop = owner.subscribeView(() => {});
  const oldB = owner.row("b");
  f.publish([row("older", { createdAt: 150 }), a, b]);
  expect(owner.view().ids).toEqual(["older", "a", "b"]);
  expect(owner.row("a")?.day).toBe(false);
  expect(owner.row("a")?.stackPrevious).toBe(true);
  expect(owner.row("b")).toBe(oldB);
  f.publish([row("older", { authorId: "b", createdAt: 150 }), a, b]);
  expect(owner.row("a")?.stackPrevious).toBe(false);
  expect(owner.row("older")?.stackNext).toBe(false);
  stop();
});

it("keeps newest-anchored membership groups current across prepend and split", () => {
  const joined = (id: string, target: string, time: number) =>
    row(id, {
      createdAt: time,
      membership: { type: "member_joined", actor: target, target },
    });
  const a = joined("join-a", "a", 200),
    b = joined("join-b", "b", 220);
  const f = fixture([a, b]),
    owner = open(f);
  const stop = owner.subscribeView(() => {});
  expect(owner.view().ids).toEqual(["join-b"]);
  const old = owner.row("join-b");
  f.publish([joined("older", "c", 180), a, b]);
  expect(owner.view().ids).toEqual(["join-b"]);
  expect(owner.row("join-b")?.row.membershipRows?.map((r) => r.id)).toEqual([
    "older",
    "join-a",
    "join-b",
  ]);
  expect(owner.row("join-b")?.row.createdAt).toBe(180);
  expect(old?.row.membershipRows).toHaveLength(2);
  f.publish([a, row("separator", { authorId: "b", createdAt: 210 }), b]);
  expect(owner.view().ids).toEqual(["join-a", "separator", "join-b"]);
  stop();
});

it("uses complete activity runs when an insertion merges or splits a disclosure", () => {
  const steps = Array.from({ length: 8 }, (_, i) =>
    row(`step${i}`, { audience: "agents", createdAt: 100 + i }),
  );
  const f = fixture(steps),
    owner = open(f, true);
  const stop = owner.subscribeView(() => {});
  expect(owner.view().activity[0]?.ids).toEqual(steps.map((r) => r.id));
  f.publish([
    ...steps.slice(0, 4),
    row("human", { createdAt: 103.5 }),
    ...steps.slice(4),
  ]);
  expect(owner.view().activity).toEqual([]);
  f.publish(steps);
  expect(owner.view().activity[0]?.ids).toEqual(steps.map((r) => r.id));
  stop();
});

it("catches a publication between the first read and subscription and fences late retired callbacks", () => {
  const a = row("a"),
    f = fixture([a]),
    owner = open(f);
  expect([...f.sources.values()].every((s) => s.size === 0)).toBe(true);
  f.publish([row("a", { content: "arrived before subscribe" })]);
  const stop = owner.subscribeRow("a", () => {});
  expect(owner.row("a")?.row.content).toBe("arrived before subscribe");
  const late = [...f.sources.values()].flatMap((s) => [...s]);
  stop();
  expect([...f.sources.values()].every((s) => s.size === 0)).toBe(true);
  f.publish([row("a", { content: "retired source" })]);
  for (const callback of late) callback();
  expect(owner.row("a")?.row.content).toBe("arrived before subscribe");
  const reconnect = owner.subscribeView(() => {});
  expect(owner.row("a")?.row.content).toBe("retired source");
  reconnect();
});

it("keeps same-ID replacement sessions isolated, removes revoked rows and updates channel permission facts", () => {
  const f = fixture([row("same")]),
    g = fixture([row("same", { content: "other session" })]);
  const a = open(f),
    b = open(g);
  const stops = [a.subscribeView(() => {}), b.subscribeView(() => {})];
  f.channel({ cached: true, readOnly: true, archived: true });
  expect(a.row("same")?.permissions).toEqual({
    listed: true,
    cached: true,
    readOnly: true,
    archived: true,
  });
  expect(b.row("same")?.permissions.readOnly).toBe(false);
  f.publish([], { status: "error", error: "Access revoked" });
  expect(a.row("same")).toBeUndefined();
  expect(a.view().ids).toEqual([]);
  expect(b.row("same")?.row.content).toBe("other session");
  for (const stop of stops) stop();
});

it("does not retain optional window flags after a source snapshot removes them", () => {
  const f = fixture([row("a")]),
    owner = open(f);
  const stop = owner.subscribeHeader(() => {});
  f.metadata({ historyLimited: true });
  expect(owner.header().historyLimited).toBe(true);
  // A reset can omit an optional field rather than supply false.
  f.removeHistoryLimit();
  expect(owner.header().historyLimited).toBeUndefined();
  stop();
});

it("publishes explicit target names on the initial read without a subscription catch-up", () => {
  const target = "ef".repeat(32),
    href = profileTarget(target);
  if (!href) throw new Error("Invalid fixture identity");
  const f = fixture([row("explicit", { content: `[Authored](${href})` })]);
  f.profile(target, { name: "Current unscoped target" });
  const owner = open(f);
  expect(owner.names([target]).snapshot().get(target)).toBe(
    "Current unscoped target",
  );
  expect(
    [...f.sources.values()].every((listeners) => listeners.size === 0),
  ).toBe(true);
});
