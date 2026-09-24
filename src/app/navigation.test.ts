// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { supportsSettingsSection } from "./navigation";

describe("supportsSettingsSection", () => {
  it("allows the demo wallet only in developer mode", () => {
    expect(supportsSettingsSection("wallet", true)).toBe(true);
    expect(supportsSettingsSection("wallet", false)).toBe(false);
  });

  it("keeps the developer page restricted and standard sections available", () => {
    expect(supportsSettingsSection("developer", true)).toBe(true);
    expect(supportsSettingsSection("developer", false)).toBe(false);
    expect(supportsSettingsSection("profile", false)).toBe(true);
    expect(supportsSettingsSection(undefined, false)).toBe(true);
    expect(supportsSettingsSection("unsupported", true)).toBe(false);
  });
});
