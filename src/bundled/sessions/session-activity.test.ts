import { expect, it } from "vitest";
import type { ActivityTurn } from "../../features/agents/activity";
import type { RetainedChannelMessage } from "../../features/relay/contracts";
import { sessionActivity } from "./session-activity";
const id = (n: number) => n.toString(16).padStart(64, "0");
const row = (
  n: number,
  parent?: number,
  channelId = "a",
): RetainedChannelMessage => ({
  id: id(n),
  channelId,
  threadRootId: parent === undefined ? undefined : id(parent),
  authorId: id(99),
  createdAt: 1,
  excerpt: "same title",
  mentions: [],
  participants: [],
  edited: false,
  quietSession: false,
  chipSession: false,
});
const turn = (
  ids: number[],
  patch: Partial<ActivityTurn> = {},
): ActivityTurn => ({
  agent: id(99),
  turnId: "one",
  channelId: "a",
  timestamp: 1,
  state: "working",
  triggeringEventIds: ids.map(id),
  ...patch,
});
it("joins every trigger to one retained canonical root, including legacy parent chains", () => {
  const rows = [row(1), row(2, 1), row(3, 2), row(4)];
  const result = sessionActivity(rows, [turn([1, 2, 3, 3])]);
  expect([...result]).toEqual([[`a/${id(1)}`, "working"]]);
  expect(rows.map((r) => r.createdAt)).toEqual([1, 1, 1, 1]);
});
it.each([
  [
    [row(1), row(2, 1)],
    [1, 9],
  ], // one missing trigger invalidates the whole batch
  [
    [row(1), row(2)],
    [1, 2],
  ], // real multiple roots
  [[row(2, 1)], [2]], // never allocates a missing root
  [[row(1), row(2, 1, "b")], [2]], // no cross-channel message lookup
  [[row(1, undefined, "b"), row(2, 1)], [2]], // no cross-channel root lookup
  [[row(1, 2), row(2, 1)], [1]], // cycle
  [[row(1, 1)], [1]], // self-cycle is not a root
  [[{ ...row(1), threadRootId: "invalid" }], [1]],
  [[{ ...row(1), threadRootId: "" }], [1]],
  [[...Array.from({ length: 33 }, (_, i) => row(i, i + 1)), row(33)], [0]], // bounded walk
] as const)("omits unresolved or ambiguous evidence %#", (rows, ids) => {
  expect(sessionActivity(rows, [turn([...ids])]).size).toBe(0);
});
it("ignores ended/unscoped/uncorrelated turns; working beats unknown across exact agent/turn evidence", () => {
  const rows = [row(1), row(2)];
  expect(
    sessionActivity(rows, [
      turn([1], { state: "ended" }),
      turn([2], { channelId: null }),
      turn([], {}),
    ]).size,
  ).toBe(0);
  const a = turn([1], { state: "unknown" }),
    b = turn([1], { agent: id(88), turnId: "other" });
  expect([...sessionActivity(rows, [a, b, a])]).toEqual([
    [`a/${id(1)}`, "working"],
  ]);
  expect([...sessionActivity(rows, [a, { ...b, state: "ended" }])]).toEqual([
    [`a/${id(1)}`, "unknown"],
  ]);
  expect([...sessionActivity([], [b])]).toEqual([]);
});
