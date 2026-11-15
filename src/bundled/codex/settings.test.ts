import { expect, it } from "vitest";
import { config, defaults } from "./config";
import {
  syncedSettings,
  syncedSettingsSchema,
  withSyncedSettings,
} from "./settings";
import { settingsProblem } from "../../features/agents/agent-config";

it("round-trips each agent's voice through saved and synced settings", () => {
  for (const voice of ["cove", "maple", ""]) {
    const saved = config(JSON.parse(JSON.stringify({ ...defaults, voice })));
    expect(saved.voice).toBe(voice);
    const synced = syncedSettings(saved);
    expect(settingsProblem(syncedSettingsSchema, synced)).toBeUndefined();
    expect(
      withSyncedSettings({ ...defaults, voice: "sol" }, synced).voice,
    ).toBe(voice);
  }
});
it("defaults old settings instead of inheriting this device's voice", () => {
  expect(withSyncedSettings({ ...defaults, voice: "maple" }, {}).voice).toBe(
    "",
  );
  expect(config({}).voice).toBe("");
});
it.each([null, 123])("does not send an unsupported local voice %s", (voice) => {
  expect(config({ voice }).voice).toBe("");
});
it("preserves catalog voices across hosts and rejects non-text synced values", () => {
  expect(config({ voice: "future-voice" }).voice).toBe("future-voice");
  expect(settingsProblem(syncedSettingsSchema, { voice: 123 })).toBeDefined();
  expect(syncedSettings(config({}))).not.toHaveProperty("voice");
});
