import { expect, it } from "vitest";
import {
  validSidebarAssignment,
  validSidebarChannelId,
  validSidebarSort,
} from "./sidebar-edits";

it("bounds sidebar identifiers without normalizing their wire value", () => {
  for (const id of ["c", " c ", "x".repeat(256), "😀".repeat(128)])
    expect(validSidebarChannelId(id)).toBe(true);
  for (const id of ["", " ", "x".repeat(257), "😀".repeat(129)])
    expect(validSidebarChannelId(id)).toBe(false);
});

it("validates create-section policy separately from the host envelope", () => {
  const createSection = {
    id: "11111111-1111-1111-1111-111111111111",
    name: " Work ",
  };
  expect(validSidebarAssignment({ channelId: "c", createSection })).toBe(true);
  expect(validSidebarAssignment({ channelId: "c" })).toBe(true);
  for (const intent of [
    { channelId: "c", sectionId: "" },
    { channelId: "c", sectionId: "existing", createSection },
    { channelId: "c", createSection: { ...createSection, id: "bad" } },
    { channelId: "c", createSection: { ...createSection, name: " " } },
    {
      channelId: "c",
      createSection: { ...createSection, name: "x".repeat(257) },
    },
  ])
    expect(validSidebarAssignment(intent)).toBe(false);
});

it("retains built-in and known-section sorting limits", () => {
  for (const group of ["starred", "channels", "forums", "dms"])
    for (const mode of ["alpha", "recent"] as const)
      expect(validSidebarSort(group, mode, [])).toBe(true);
  const section = "x".repeat(256);
  expect(validSidebarSort(`section:${section}`, "recent", [section])).toBe(
    true,
  );
  expect(validSidebarSort("section:unknown", "recent", [])).toBe(false);
  expect(
    validSidebarSort(`section:${section}x`, "recent", [`${section}x`]),
  ).toBe(false);
  expect(validSidebarSort("channels", "alpha", Array(100).fill("s"))).toBe(
    true,
  );
  expect(validSidebarSort("channels", "alpha", Array(101).fill("s"))).toBe(
    false,
  );
  expect(validSidebarSort("channels", "recent", [" "])).toBe(false);
});
