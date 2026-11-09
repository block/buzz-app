import { expect, it, vi } from "vitest";
import type { ConfigurationState, PluginInfo } from "../../plugins/types";
import { pluginOwners } from "./plugin-owners";

const plugin = (
  id: string,
  name: string,
  source: PluginInfo["source"],
): PluginInfo => ({
  manifest: { id, name, apiVersion: 1 },
  source,
  enabled: true,
  revision: "r1",
  previous: null,
  reloadable: false,
  error: null,
});
const ready: ConfigurationState = {
  status: "ready",
  externalPluginsPaused: false,
  catalog: {
    profile: "fixture",
    location: "Fixture",
    plugins: [
      plugin("acme.notes", "Acme Notes", "external"),
      plugin("buzz.channels", "Channels", "bundled"),
    ],
  },
};

it("names an external plugin and opens its management in Settings", () => {
  const manage = vi.fn();
  const owner = pluginOwners(ready, manage)("acme.notes");
  expect(owner?.name).toBe("Acme Notes");
  owner?.manage();
  expect(manage).toHaveBeenCalledExactlyOnceWith("acme.notes");
});

it("leaves built-in and unknown plugins unnamed", () => {
  const owners = pluginOwners(ready, vi.fn());
  expect(owners("buzz.channels")).toBeUndefined();
  expect(owners("missing.plugin")).toBeUndefined();
});

it("names nothing until the catalog is ready", () => {
  for (const configuration of [
    { status: "loading" },
    { status: "recovery", reason: "Unreadable", canReset: true },
  ] satisfies ConfigurationState[])
    expect(pluginOwners(configuration, vi.fn())("acme.notes")).toBeUndefined();
});
