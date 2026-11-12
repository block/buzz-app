import { afterEach, expect, it, vi } from "vitest";
import { namingGuidelinesUrl, namingRulesApply } from "./channel-naming-policy";

afterEach(() => vi.unstubAllEnvs());

it("applies nowhere unless the build lists the community", () => {
  expect(namingRulesApply("wss://relay.example")).toBe(false);
  vi.stubEnv(
    "VITE_BUZZ_CHANNEL_NAMING_ENFORCED_COMMUNITIES",
    "https://relay.example",
  );
  expect(namingRulesApply("wss://relay.example")).toBe(true);
  expect(namingRulesApply("https://relay.example/")).toBe(true);
  expect(namingRulesApply("wss://other.example")).toBe(false);
  expect(namingRulesApply("wss://relay.example.evil.com")).toBe(false);
  expect(namingRulesApply(undefined)).toBe(false);
  expect(namingRulesApply("not a url")).toBe(false);
});

it("reads the guidelines link from the build", () => {
  expect(namingGuidelinesUrl()).toBeUndefined();
  vi.stubEnv("VITE_BUZZ_CHANNEL_NAMING_GUIDELINES_URL", "https://go.example/x");
  expect(namingGuidelinesUrl()).toBe("https://go.example/x");
});
