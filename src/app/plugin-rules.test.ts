import { expect, test } from "vitest";
import type { PluginInfo } from "../plugins/types";
import { isRequiredPlugin, pluginToggleDisabled } from "./plugin-rules";

const plugin = (id: string, enabled: boolean): PluginInfo => ({
  manifest: { id, name: id, apiVersion: 1 } as PluginInfo["manifest"],
  source: "bundled",
  enabled,
  revision: "r1",
  previous: null,
  reloadable: false,
  error: null,
});

test("Channels is required", () => {
  expect(isRequiredPlugin(plugin("buzz.channels", true))).toBe(true);
  expect(isRequiredPlugin(plugin("buzz.reminders", true))).toBe(false);
});

test("busy changes and restricted plugins without access are locked", () => {
  expect(
    pluginToggleDisabled(plugin("buzz.reminders", false), "allowed", false),
  ).toBe(false);
  expect(
    pluginToggleDisabled(plugin("buzz.reminders", false), "allowed", true),
  ).toBe(true);
  expect(
    pluginToggleDisabled(plugin("buzz.moderation", false), "denied", false),
  ).toBe(true);
  // Turning a restricted plugin off never needs access.
  expect(
    pluginToggleDisabled(plugin("buzz.moderation", true), "denied", false),
  ).toBe(false);
});
