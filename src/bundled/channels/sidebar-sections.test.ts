import { expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { isChannelSectionKey, sidebarSections } from "./sidebar-sections";

const row = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({ id, name: id, ...extra });
it("identifies custom and general channel sections", () => {
  expect(isChannelSectionKey("channels")).toBe(true);
  expect(isChannelSectionKey("group:engineering")).toBe(true);
  expect(isChannelSectionKey("starred")).toBe(false);
  expect(isChannelSectionKey("forums")).toBe(false);
  expect(isChannelSectionKey("dms")).toBe(false);
});
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
    row("session", { channelType: "session" }),
  ];
  const preferences = {
    sections: [{ id: "channels", name: "Channels", icon: ":party:", order: 0 }],
    assignments: {
      star: "channels",
      work: "channels",
      revoked: "channels",
      "group-dm": "channels",
      other: "missing",
    },
    muted: [],
    starred: [
      "star",
      "archived",
      "hidden",
      "revoked",
      "dm",
      "forum",
      "session",
    ],
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
  expect(sidebarSections(roster, preferences)[1]?.icon).toBe(":party:");
  // Hiding every DM removes its rows but keeps the New message entry point.
  expect(
    sidebarSections(roster, preferences, new Set(["dm", "group-dm"])).find(
      (section) => section.key === "dms",
    ),
  ).toEqual({
    key: "dms",
    title: "Direct messages",
    icon: undefined,
    rows: [],
  });
  expect(
    project(roster.filter((channel) => channel.id !== "star")),
  ).not.toContainEqual(["starred", ["star"]]);
  expect(sidebarSections([])).toEqual([
    { key: "channels", title: "Channels", icon: undefined, rows: [] },
    { key: "dms", title: "Direct messages", icon: undefined, rows: [] },
  ]);
  expect(
    sidebarSections(roster).flatMap((section) =>
      section.rows.map((channel) => channel.id),
    ),
  ).toEqual(["star", "work", "other", "forum", "dm", "group-dm"]);
});
