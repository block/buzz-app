import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import type {
  RegisteredSidebarRows,
  SidebarRow,
  SidebarRowContribution,
} from "./sidebar-rows-service";
import { groupSidebarRows, SidebarRowsService } from "./sidebar-rows-service";

it("orders active scopes by contribution key and removes registrations on disable and teardown", async () => {
  const root = new Context();
  const active = new Set(["z.plugin", "a.plugin"]);
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: (id: string) => active.has(id),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const registry = new SidebarRowsService(root);
  const value: SidebarRowContribution = {
    version: 1,
    id: "rows",
    render: (_, Default) => Default,
  };
  const fibers = ["z.plugin", "a.plugin"].map((id) =>
    root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => ctx.reflect.get("sidebarRows")?.register(value)),
  );
  try {
    await Promise.all(fibers.map((fiber) => fiber.await()));
    expect(registry.snapshot().map((entry) => entry.key)).toEqual([
      "a.plugin/rows",
      "z.plugin/rows",
    ]);
    expect(registry.snapshot()).toBe(registry.snapshot());
    active.delete("a.plugin");
    for (const listener of listeners) listener();
    expect(registry.snapshot().map((entry) => entry.key)).toEqual([
      "z.plugin/rows",
    ]);
    await fibers[0]?.dispose();
    expect(registry.snapshot()).toEqual([]);
  } finally {
    await root.fiber.dispose();
  }
});

it.each([
  [
    "duplicate mode ids",
    "example.plugin",
    {
      sortModes: [
        { id: "one", label: "One", compare: (): number => 0 },
        { id: "one", label: "Two", compare: (): number => 0 },
      ],
    },
  ],
  [
    "blank label",
    "example.plugin",
    { sortModes: [{ id: "one", label: "  ", compare: (): number => 0 }] },
  ],
  [
    "non-function comparator",
    "example.plugin",
    { sortModes: [{ id: "one", label: "One", compare: null }] },
  ],
  ["non-function renderer", "example.plugin", { render: false }],
  ["non-function group", "example.plugin", { group: "working" }],
  [
    "incompatible owner id",
    "MixedCase",
    { sortModes: [{ id: "one", label: "One", compare: (): number => 0 }] },
  ],
] as const)(
  "rejects %s without publishing a partial contribution",
  async (_, owner, fields) => {
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const registry = new SidebarRowsService(root);
    let register = () => {};
    const fiber = root
      .extend({ pluginOwner: { id: owner, revision: "one" } })
      .plugin((ctx) => {
        register = () =>
          ctx.reflect.get("sidebarRows")?.register({
            version: 1,
            id: "rows",
            render: (_, Default) => Default,
            ...fields,
          } as SidebarRowContribution);
      });
    try {
      await fiber.await();
      expect(register).toThrow();
      expect(registry.snapshot()).toEqual([]);
    } finally {
      await root.fiber.dispose();
    }
  },
);

const rowOf = (id: string, working = false) =>
  ({ id, label: id, working }) as SidebarRow;
const entry = (
  key: string,
  group: SidebarRowContribution["group"],
): RegisteredSidebarRows =>
  ({
    id: key,
    key,
    pluginId: key,
    revision: "1",
    version: 1,
    group,
  }) as RegisteredSidebarRows;
const grouped = (
  ids: string[],
  entries: RegisteredSidebarRows[],
): [string, string | undefined][] =>
  groupSidebarRows(ids, entries, rowOf).map(({ row, group }) => [
    row,
    group?.id,
  ]);
const working = (row: SidebarRow) =>
  row.id.startsWith("w") ? { id: "working", label: "Working" } : null;

describe("groupSidebarRows", () => {
  it("leaves rows untouched without group contributions", () => {
    expect(grouped(["a", "b"], [])).toEqual([
      ["a", undefined],
      ["b", undefined],
    ]);
    expect(grouped(["a"], [entry("render-only", undefined)])).toEqual([
      ["a", undefined],
    ]);
  });

  it("gathers each group at its first member and keeps every row", () => {
    expect(
      grouped(["a", "w1", "b", "w2", "c"], [entry("one", working)]),
    ).toEqual([
      ["a", undefined],
      ["w1", "working"],
      ["w2", "working"],
      ["b", undefined],
      ["c", undefined],
    ]);
  });

  it("uses the first valid group and ignores throws and invalid results", () => {
    const entries = [
      entry("a", () => {
        throw new Error("boom");
      }),
      entry("b", () => ({ id: "Bad Id", label: "Bad" })),
      entry("c", () => ({ id: "blank", label: "  " })),
      entry("d", () => undefined),
      entry("e", () => ({ id: "first", label: "First" })),
      entry("f", () => ({ id: "second", label: "Second" })),
    ];
    expect(grouped(["x", "y"], entries)).toEqual([
      ["x", "first"],
      ["y", "first"],
    ]);
    expect(grouped(["x"], entries.slice(0, 4))).toEqual([["x", undefined]]);
  });
});
