import { expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { sidebarSections } from "./sidebar-sections";

const row = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({ id, name: id, ...extra });
it("intersects groups/stars with active authorized streams, keeping forums and DMs separate", () => {
  const roster = [
    row("star"),
    row("work"),
    row("other"),
    row("archived", { archived: true }),
    row("hidden", { hidden: true }),
    row("dm", { channelType: "dm", hidden: true }),
    row("group-dm", { channelType: "dm", participants: ["a", "b"] }),
    row("forum", { channelType: "forum" }),
  ];
  const preferences = {
    sections: [{ id: "channels", name: "Channels", order: 0 }],
    assignments: {
      star: "channels",
      work: "channels",
      revoked: "channels",
      "group-dm": "channels",
      other: "missing",
    },
    starred: ["star", "archived", "hidden", "revoked", "dm", "forum"],
  };
  const project = (channels: readonly ChannelSummary[]) =>
    sidebarSections(channels, preferences).map((section) => [
      section.key,
      section.rows.map((channel) => channel.id),
    ]);
  expect(project(roster)).toEqual([
    ["starred", ["star"]],
    ["group:channels", ["work"]],
    ["channels", ["other"]],
    ["forums", ["forum"]],
    ["dms", ["dm", "group-dm"]],
  ]);
  expect(
    project(roster.filter((channel) => channel.id !== "star")),
  ).not.toContainEqual(["starred", ["star"]]);
  expect(
    sidebarSections(roster).flatMap((section) =>
      section.rows.map((channel) => channel.id),
    ),
  ).toEqual(["other", "star", "work", "forum", "dm", "group-dm"]);
});

it("sorts every section independently with deterministic inactive and tie fallbacks", () => {
  const roster = [
    row("z-id", { name: "same", lastActivityAt: 20 }),
    row("a-id", { name: "Same", lastActivityAt: 20 }),
    row("new", { name: "Zulu", lastActivityAt: 30 }),
    row("quiet-b", { name: "beta" }),
    row("quiet-a", { name: "Alpha" }),
    row("forum-old", {
      name: "Forum old",
      channelType: "forum",
      lastActivityAt: 5,
    }),
    row("forum-new", {
      name: "Forum new",
      channelType: "forum",
      lastActivityAt: 10,
    }),
  ];
  const preferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: {
      "z-id": "work",
      "a-id": "work",
      new: "work",
      "quiet-b": "work",
      "quiet-a": "work",
    },
    starred: [],
    sort: { "section:work": "recent" as const, forums: "alpha" as const },
  };
  expect(
    sidebarSections(roster, preferences).map((section) => [
      section.key,
      section.rows.map((channel) => channel.id),
    ]),
  ).toEqual([
    ["group:work", ["new", "a-id", "z-id", "quiet-a", "quiet-b"]],
    ["forums", ["forum-new", "forum-old"]],
  ]);
  expect(sidebarSections(roster)[0]?.rows.map((channel) => channel.id)).toEqual(
    ["quiet-a", "quiet-b", "a-id", "z-id", "new"],
  );
});
