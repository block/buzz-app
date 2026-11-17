import { expect, it } from "vitest";
import {
  editSidebarRecord,
  nextSidebarSectionOrder,
} from "./sidebar-registers";
import { projectSidebarPreferences } from "./sidebar-preferences";
const dev = "1234567890abcdef";
const reg = (value: unknown, v = 100) => [v, dev, value];
const sections = () => ({
  version: 1,
  sections: [],
  assignments: {},
  meta: {
    v: 1,
    s: {
      live: {
        name: reg("Work"),
        order: reg(99),
        live: reg(true),
        icon: reg(null),
      },
      dead: { name: reg("Deleted"), live: reg(false), order: reg(1000) },
    },
    a: { a: reg("live"), removed: reg(null), orphan: reg("dead") },
  },
});
it("reads metadata rather than stale legacy projections and preserves deletion registers", () => {
  const current = sections();
  expect(projectSidebarPreferences(current, undefined)).toEqual({
    sections: [{ id: "live", name: "Work", order: 0 }],
    assignments: { a: "live" },
    muted: [],
  });
  const next = editSidebarRecord(current, 1, [[["a", "a"], null]], 50);
  expect(projectSidebarPreferences(next, undefined).assignments).toEqual({});
  expect(next.meta).toEqual({
    ...current.meta,
    a: {
      ...current.meta.a,
      a: [101, expect.stringMatching(/^[0-9a-f]{16}$/), null],
    },
  });
  expect(current.meta.a.a).toEqual(reg("live"));
  expect(editSidebarRecord(next, 1, [[["a", "a"], null]])).toBe(next);
  expect(nextSidebarSectionOrder(current)).toBe(100);
});
it("prepends before canonical negative orders without counting deleted sections", () => {
  const current = editSidebarRecord(
    sections(),
    1,
    [
      [["s", "live", "order"], -7],
      [["s", "dead", "order"], -100],
    ],
    110,
  );
  expect(nextSidebarSectionOrder(current, "first")).toBe(-8);
  expect(
    nextSidebarSectionOrder({ sections: [{ order: -2.4 }] }, "first"),
  ).toBe(-3);
  expect(nextSidebarSectionOrder({ sections: [] }, "first")).toBe(-1);
});

it("imports a meta-less head at event milliseconds and edits only the requested leaf", () => {
  const next = editSidebarRecord(
    {
      version: 1,
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: { a: "work", b: "work" },
    },
    10,
    [[["a", "a"], null]],
    1,
  );
  expect(next).toMatchObject({
    version: 1,
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { b: "work" },
    meta: {
      v: 1,
      a: {
        a: [10001, expect.stringMatching(/^[0-9a-f]{16}$/), null],
        b: [10000, "0000000000000000", "work"],
      },
    },
  });
  expect((next.meta as { s: { work: unknown } }).s.work).toEqual({
    name: [10000, "0000000000000000", "Work"],
    icon: [10000, "0000000000000000", null],
    order: [10000, "0000000000000000", 0],
    live: [10000, "0000000000000000", true],
  });
});
it("keeps tombstones beyond the live projection cap and refuses too many live values", () => {
  const tombstones = Object.fromEntries(
    Array.from({ length: 105 }, (_, i) => [
      `dead-${i}`,
      { name: reg("Deleted"), live: reg(false) },
    ]),
  );
  const value = {
    version: 1,
    sections: [],
    assignments: {},
    meta: { v: 1, s: tombstones, a: {} },
  };
  const next = editSidebarRecord(value, 1, [
    [["s", "work", "name"], "Work"],
    [["s", "work", "live"], true],
  ]);
  expect(projectSidebarPreferences(next, undefined).sections).toEqual([
    { id: "work", name: "Work", order: 0 },
  ]);
  expect(Object.keys((next.meta as typeof value.meta).s)).toHaveLength(106);
  expect(() =>
    projectSidebarPreferences(
      {
        ...value,
        meta: {
          v: 1,
          s: Object.fromEntries(
            Object.keys(tombstones).map((key) => [
              key,
              { name: reg("Live"), live: reg(true) },
            ]),
          ),
          a: {},
        },
      },
      undefined,
    ),
  ).toThrow("Unsupported sidebar groups");
});
it("uses own properties for dynamic keys without changing object prototypes", () => {
  const next = editSidebarRecord(sections(), 1, [
    [["a", "constructor"], "live"],
  ]);
  expect(projectSidebarPreferences(next, undefined).assignments).toEqual({
    a: "live",
    constructor: "live",
  });
  expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
  expect(() =>
    editSidebarRecord(sections(), 1, [[["a", "__proto__"], "live"]]),
  ).toThrow();
});
it.each([
  null,
  { v: 2 },
  { v: 1, a: null },
  { v: 1, other: {} },
  { v: 1, a: { channel: [1, dev] } },
  { v: 1, a: { channel: [1, dev, 5] } },
  { v: 1, a: { channel: [1.1, dev, "live"] } },
  { v: 1, a: { channel: [-1, dev, "live"] } },
  { v: 1, a: { channel: [1, "bad", "live"] } },
  { v: 1, a: { channel: [Number.MAX_SAFE_INTEGER + 1, dev, "live"] } },
])("fails closed on unsupported or malformed metadata: %j", (meta) => {
  const value = { version: 1, sections: [], assignments: {}, meta };
  expect(() => projectSidebarPreferences(value, undefined)).toThrow();
  expect(() =>
    editSidebarRecord(value, 1, [[["a", "channel"], "live"]]),
  ).toThrow();
});
it("refuses an exhausted register clock instead of emitting unsafe integers", () => {
  expect(() =>
    editSidebarRecord(
      {
        version: 1,
        sections: [],
        assignments: {},
        meta: {
          v: 1,
          s: {},
          a: { channel: reg(null, Number.MAX_SAFE_INTEGER) },
        },
      },
      1,
      [[["a", "other"], "live"]],
    ),
  ).toThrow("clock exhausted");
});

it.each(["name", "icon"])(
  "read tolerance does not admit oversized live %s or rewrite retained text",
  (field) => {
    const current = sections();
    const meta = {
      ...current.meta,
      s: {
        ...current.meta.s,
        live: { ...current.meta.s.live, [field]: reg("x".repeat(257)) },
      },
    };
    expect(() =>
      projectSidebarPreferences({ ...current, meta }, undefined),
    ).toThrow("Invalid sidebar preference text");
    const dead = {
      ...current,
      meta: {
        ...meta,
        s: { ...meta.s, live: { ...meta.s.live, live: reg(false) } },
      },
    };
    const before = structuredClone(dead);
    expect(projectSidebarPreferences(dead, undefined).sections).toEqual([]);
    expect(editSidebarRecord(dead, 1, [[["a", "a"], null]])).toBe(dead);
    expect(() =>
      editSidebarRecord(dead, 1, [[["s", "dead", "icon"], null]]),
    ).toThrow("Invalid sidebar register");
    expect(dead).toEqual(before);
  },
);

it("does not salvage malformed register envelopes or unknown retained fields on reads or writes", () => {
  for (const dead of [
    { name: [1, "bad-device", "x".repeat(257)], live: reg(false) },
    { name: reg("Deleted"), live: reg(false), future: reg("keep") },
  ]) {
    const current = sections();
    const value = {
      ...current,
      meta: { ...current.meta, s: { ...current.meta.s, dead } },
    };
    const before = structuredClone(value);
    expect(() => projectSidebarPreferences(value, undefined)).toThrow();
    expect(() => editSidebarRecord(value, 1, [[["a", "a"], null]])).toThrow();
    expect(value).toEqual(before);
  }
});

it("keeps missing-assignment removal a no-op without suppressing other null registers", () => {
  const current = sections();
  expect(editSidebarRecord(current, 1, [[["a", "missing"], null]])).toBe(
    current,
  );
  const next = editSidebarRecord(current, 1, [[["s", "dead", "icon"], null]]);
  expect(next).not.toBe(current);
  expect(next.meta).toMatchObject({
    s: { dead: { icon: [expect.any(Number), expect.any(String), null] } },
  });
});
