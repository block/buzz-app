// @vitest-environment jsdom
import { expect, it } from "vitest";
import { developerMode, isSettingsSectionId } from "./settingsSections";

it("uses the rendered settings sections as the route allowlist", () => {
  expect(isSettingsSectionId("builderlab")).toBe(true);
  expect(isSettingsSectionId("missing-section")).toBe(false);
  expect(isSettingsSectionId("developer")).toBe(developerMode);
});
