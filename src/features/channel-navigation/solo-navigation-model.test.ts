import { expect, it } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import {
  acceptSoloRows,
  projectSolo,
  soloForest,
  soloViewOptions,
  SOLO_VIEW_DEFAULTS,
} from "./solo-navigation-model";
const channel = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary =>
  ({ id, name: id, channelType: "solo", ...extra }) as ChannelSummary;
const channels = [
  channel("root"),
  channel("worker"),
  channel("ordinary"),
  channel("archived", { archived: true }),
  channel("team", { channelType: "stream" }),
];
it("keeps task trees in root placement and retains current/filter context without inventing destinations", () => {
  const forest = soloForest(
    acceptSoloRows([
      { channelId: "root", status: "archived" },
      { channelId: "worker", parentChannelId: "root", status: "running" },
      { channelId: "archived", status: "running" },
      { channelId: "team", status: "running" },
      { channelId: "inaccessible", status: "running" },
    ]),
    channels,
  );
  expect([...forest.tasks.keys()]).toEqual(["root", "worker"]);
  expect(forest.roots.get("worker")).toBe("root");
  const result = projectSolo(
    forest,
    channels.slice(0, 3),
    { ...SOLO_VIEW_DEFAULTS, show: "active-tasks" },
    "ordinary",
  );
  expect(result.roots).toEqual(["ordinary", "root"]);
  expect(result.children.get("root")).toEqual(["worker"]);
  expect([...result.context]).toEqual(["root"]);
  expect(result.outside).toBe("ordinary");
  expect(result.excluded).toBe(0);
  expect(
    soloForest(
      Array.from(forest.tasks.values()),
      channels.filter((item) => item.id !== "root"),
    ).roots.get("worker"),
  ).toBe("worker");
});
it("uses authoritative host names and root activity with deterministic ties", () => {
  const items = [
    channel("a", { name: "Zulu", lastActivityAt: 1 }),
    channel("b", { name: "Alpha", lastActivityAt: 2 }),
    channel("c", { name: "Alpha", lastActivityAt: 2 }),
  ];
  const forest = soloForest([], items);
  expect(projectSolo(forest, items, SOLO_VIEW_DEFAULTS).roots).toEqual([
    "b",
    "c",
    "a",
  ]);
  expect(
    projectSolo(forest, items, { ...SOLO_VIEW_DEFAULTS, sort: "name" }).roots,
  ).toEqual(["b", "c", "a"]);
});
it.each([
  [{ channelId: "a", status: "unknown" }],
  [
    { channelId: "a", status: "done" },
    { channelId: "a", status: "done" },
  ],
  [{ channelId: "a", status: "done", subtitle: "x".repeat(241) }],
  [
    {
      channelId: "a",
      status: "done",
      details: Array(5).fill({ label: "l", value: "v" }),
    },
  ],
  Array(257).fill({ channelId: "a", status: "done" }),
])("rejects bounded malformed snapshots atomically", (rows) => {
  expect(() => acceptSoloRows(rows)).toThrow();
});
it("rejects remaining cycles but accepts unknown parents as roots", () => {
  const rows = acceptSoloRows([
    { channelId: "root", parentChannelId: "worker", status: "done" },
    { channelId: "worker", parentChannelId: "root", status: "done" },
  ]);
  expect(() => soloForest(rows, channels)).toThrow("Cyclic");
  expect(
    soloForest(
      acceptSoloRows([
        { channelId: "root", parentChannelId: "unknown", status: "done" },
      ]),
      channels,
    ).roots.get("root"),
  ).toBe("root");
  expect(soloViewOptions({ group: "bogus", sort: "name", show: null })).toEqual(
    { ...SOLO_VIEW_DEFAULTS, sort: "name" },
  );
});
