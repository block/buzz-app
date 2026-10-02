import { expect, it } from "vitest";
import { retainReadState } from "./read-state-retention";
import {
  effectiveFrontier,
  overrideActive,
  READ_STATE_PLAINTEXT_BYTES,
} from "./read-state-model";

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
it("keeps an old channel mark when newer message reads fill the budget", () => {
  const thread = `thread:${"a".repeat(64)}`;
  const flood = Object.fromEntries(
    Array.from({ length: 2000 }, (_, n) => [
      `msg:${n.toString(16).padStart(64, "0")}`,
      1000 + n,
    ]),
  );
  const state = {
    frontiers: { quiet: 50, "activity:other": 40, [thread]: 30, ...flood },
    overrides: {},
  };
  // Every message read is more recent than the channel and thread reads.
  const recent = Object.fromEntries(
    Object.keys(flood).map((key, n) => [key, 10 + n]),
  );
  for (const budget of [undefined, READ_STATE_PLAINTEXT_BYTES]) {
    const kept = retainReadState([state], recent, "fixture", budget);
    expect(kept.frontiers).toMatchObject({
      quiet: 50,
      "activity:other": 40,
      [thread]: 30,
    });
    expect(Object.keys(kept.frontiers).length).toBeLessThan(2003);
  }
});
it("at the synced limit, recent catch-up never pushes out a quiet channel's mark", () => {
  const id = (prefix: string, n: number) =>
    `${prefix}${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  // Logan's Sep 28 state had 295 channel marks. Every channel and thread
  // mark is older and less recently used than every catch-up mark.
  const channels = Array.from({ length: 300 }, (_, n) => id("", n));
  const threads = Array.from(
    { length: 100 },
    (_, n) => `thread:${n.toString(16).padStart(64, "0")}`,
  );
  const activity = Array.from({ length: 600 }, (_, n) =>
    id("activity:", 1000 + n),
  );
  const state = {
    frontiers: Object.fromEntries([
      ...channels.map((key) => [key, 10] as const),
      ...threads.map((key) => [key, 20] as const),
      ...activity.map((key, n) => [key, 1000 + n] as const),
    ]),
    overrides: {},
  };
  const recent = Object.fromEntries(activity.map((key, n) => [key, 100 + n]));
  const kept = retainReadState(
    [state],
    recent,
    "fixture",
    READ_STATE_PLAINTEXT_BYTES,
  );
  const keys = Object.keys(kept.frontiers);
  // The budget is genuinely full: some catch-up marks did not fit.
  expect(keys.filter((key) => key.startsWith("activity:")).length).toBeLessThan(
    activity.length,
  );
  for (const key of [...channels, ...threads])
    expect(kept.frontiers[key]).toBe(state.frontiers[key]);
});
it("old broad marks never crowd out the newest read", () => {
  const hex = (n: number) => n.toString(16).padStart(64, "0");
  const uuid = (n: number) =>
    `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const fresh = `msg:${"f".repeat(64)}`;
  const cases = [
    // Stale thread catch-up marks alone exceed the local budget.
    {
      budget: undefined,
      old: Array.from({ length: 1300 }, (_, n) => `thread-activity:${hex(n)}`),
      kept: [] as string[],
    },
    // Stale channel catch-up marks fill the synced budget.
    {
      budget: READ_STATE_PLAINTEXT_BYTES,
      old: Array.from({ length: 900 }, (_, n) => `activity:${uuid(n)}`),
      kept: [] as string[],
    },
    // The Sep 28 state: 295 channel marks and 459 thread marks.
    {
      budget: READ_STATE_PLAINTEXT_BYTES,
      old: [
        ...Array.from({ length: 295 }, (_, n) => uuid(n)),
        ...Array.from({ length: 459 }, (_, n) => `thread:${hex(n)}`),
      ],
      kept: Array.from({ length: 295 }, (_, n) => uuid(n)),
    },
  ];
  for (const { budget, old, kept: quiet } of cases) {
    const state = {
      frontiers: {
        ...Object.fromEntries(old.map((key, n) => [key, 100 + n])),
        [fresh]: 50,
      },
      overrides: {},
    };
    const recent = {
      ...Object.fromEntries(old.map((key, n) => [key, 10 + n])),
      [fresh]: 100_000,
    };
    const kept = retainReadState([state], recent, "fixture", budget);
    // The budget is genuinely full.
    expect(Object.keys(kept.frontiers).length).toBeLessThan(old.length + 1);
    expect(kept.frontiers[fresh]).toBe(50);
    // Quiet channel marks still fit in the broad share.
    for (const key of quiet)
      expect(kept.frontiers[key]).toBe(state.frontiers[key]);
  }
});
it("drops covered marks before the budget, unless overrides need ancestry", () => {
  const state = {
    frontiers: { room: 20, "msg:covered": 10, "msg:other": 30 },
    overrides: {},
  };
  const covered = (key: string, frontiers: ReadonlyMap<string, number>) =>
    key === "msg:covered" && (frontiers.get("room") ?? -1) >= 10;
  expect(
    retainReadState([state], {}, "fixture", undefined, covered).frontiers,
  ).toEqual({ room: 20, "msg:other": 30 });
  const withOverride = {
    ...state,
    overrides: { other: { set: 0, clear: 9, baseline: 0 } },
  };
  expect(
    retainReadState([withOverride], {}, "fixture", undefined, covered)
      .frontiers,
  ).toEqual(state.frontiers);
});
