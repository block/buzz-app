import { expect, it } from "vitest";
import { retainReadState } from "./read-state-retention";
import { effectiveFrontier, overrideActive } from "./read-state-model";

it("prunes only expendable frontiers and never loses floors or ancestry that makes a child override inactive", () => {
  const state = {
    frontiers: {
      room: 20,
      "thread:root": 30,
      "msg:child": 1,
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, n) => [`msg:${n}`, 100]),
      ),
    },
    overrides: {
      "msg:child": { set: 4, clear: 0, baseline: 15 },
      other: { set: 0, clear: 9, baseline: 0 },
    },
  };
  const kept = retainReadState([state], {}, "fixture", 512);
  expect(kept.overrides).toEqual(state.overrides);
  expect(kept.frontiers.room).toBe(20);
  expect(kept.frontiers["thread:root"]).toBe(30);
  expect(kept.frontiers["msg:child"]).toBe(1);
  expect(
    overrideActive(
      kept.overrides["msg:child"],
      effectiveFrontier(kept, "msg:child", "room", "root"),
    ),
  ).toBe(false);
  expect(() => retainReadState([state], {}, "fixture", 50)).toThrow("capacity");
});
it("a recent local read of old history outranks remote event age, without inventing a channel prefix", () => {
  const state = {
    frontiers: {
      "msg:old": 1,
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, n) => [`msg:${n}`, 100]),
      ),
    },
    overrides: {},
  };
  const kept = retainReadState([state], { "msg:old": 1 }, "fixture", 128);
  expect(kept.frontiers["msg:old"]).toBe(1);
  expect(
    Object.keys(kept.frontiers).every((key) => key.startsWith("msg:")),
  ).toBe(true);
  expect(kept).toEqual(
    retainReadState([kept, state], { "msg:old": 1 }, "fixture", 128),
  );
});
