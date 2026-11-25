import { expect, it } from "vitest";
import {
  avatarIcon,
  avatarIconGlyph,
  avatarIcons,
} from "../../shared/design-system/icons/avatar-icons";
import { iconInk } from "./avatar-upload";

it("names every icon once and reads it back from its glyph", () => {
  const ids = avatarIcons.map((icon) => icon.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const icon of avatarIcons) {
    expect(icon.node.length).toBeGreaterThan(0);
    expect(avatarIcon(avatarIconGlyph(icon.id))).toBe(icon);
  }
});

it("never mistakes an emoji for an icon", () => {
  expect(avatarIcon("😀")).toBeUndefined();
  expect(avatarIcon("icon:nope")).toBeUndefined();
});

it("draws dark ink on light backgrounds and white on dark ones", () => {
  expect(iconInk("#FFF4CC")).toBe("#1C1C1C");
  expect(iconInk("#7C5CFF")).toBe("#FFFFFF");
  expect(iconInk(undefined)).toBe("#1C1C1C");
});
