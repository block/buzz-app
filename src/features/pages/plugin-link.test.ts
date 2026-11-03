import { describe, expect, it } from "vitest";
import type { PluginStates } from "../../plugins/runtime";
import type {
  ConfigurationState,
  ManagedEntry,
  ManagedState,
  PluginInfo,
} from "../../plugins/types";
import { pluginLinkProblem } from "./plugin-link";

const plugin = (id: string, fields: Partial<PluginInfo> = {}): PluginInfo => ({
  manifest: { id, name: `${id} plugin`, apiVersion: 1 },
  source: "external",
  enabled: true,
  revision: "1",
  previous: null,
  reloadable: true,
  error: null,
  ...fields,
});
const entry = (id: string, state: ManagedState): ManagedEntry => ({
  id,
  repository: "https://example.com/org/plugins.git",
  reference: "main",
  commit: "0".repeat(40),
  path: ".",
  state,
});
const ready = (
  plugins: PluginInfo[],
  managed?: ManagedEntry[],
): ConfigurationState => ({
  status: "ready",
  catalog: { profile: "default", location: "/tmp", plugins },
  externalPluginsPaused: false,
  ...(managed
    ? {
        managed: {
          status: "ready",
          path: "/tmp/managed-plugins.json",
          source: "Example Org",
          plugins: managed,
          problems: [],
        },
      }
    : {}),
});
const active: PluginStates = {
  "acme.notes": { revision: "1", status: "active", error: null },
};
const link = (pluginId: string, pageId?: string) =>
  ({
    version: 1,
    kind: "plugin",
    pluginId,
    ...(pageId === undefined ? {} : { pageId }),
  }) as const;

describe("pluginLinkProblem", () => {
  it("reports a missing plugin that a managed recommendation offers", () => {
    expect(
      pluginLinkProblem(
        link("acme.notes", "main"),
        ready([], [entry("acme.notes", "missing")]),
        {},
      ),
    ).toEqual({ reason: "missing", name: "acme.notes", source: "Example Org" });
  });

  it("reports a missing plugin without a recommendation", () => {
    for (const configuration of [
      ready([]),
      ready([], [entry("other.plugin", "missing")]),
      ready([], [entry("acme.notes", "outdated")]),
    ])
      expect(pluginLinkProblem(link("acme.notes"), configuration, {})).toEqual({
        reason: "missing",
        name: "acme.notes",
      });
  });

  it("reports an installed plugin that is turned off by its own name", () => {
    expect(
      pluginLinkProblem(
        link("acme.notes"),
        ready([plugin("acme.notes", { enabled: false })]),
        {},
      ),
    ).toEqual({ reason: "disabled", name: "acme.notes plugin" });
  });

  it("reports the page an enabled, running plugin does not register", () => {
    expect(
      pluginLinkProblem(
        link("acme.notes", "gone"),
        ready([plugin("acme.notes")]),
        active,
      ),
    ).toEqual({ reason: "no-page", name: "acme.notes plugin", pageId: "gone" });
    expect(
      pluginLinkProblem(
        link("acme.notes"),
        ready([plugin("acme.notes")]),
        active,
      ),
    ).toEqual({ reason: "no-page", name: "acme.notes plugin" });
  });

  it("stays silent when the plugin may not be the cause", () => {
    const installed = ready([plugin("acme.notes")]);
    expect(
      pluginLinkProblem(link("acme.notes"), installed, {}),
    ).toBeUndefined();
    expect(
      pluginLinkProblem(link("acme.notes"), installed, {
        "acme.notes": { revision: "1", status: "failed", error: "boom" },
      }),
    ).toBeUndefined();
    expect(
      pluginLinkProblem(
        link("acme.notes"),
        ready([plugin("acme.notes", { error: "broken" })]),
        active,
      ),
    ).toBeUndefined();
    expect(
      pluginLinkProblem(link("acme.notes"), { status: "loading" }, {}),
    ).toBeUndefined();
    expect(
      pluginLinkProblem(
        link("acme.notes"),
        { status: "recovery", reason: "unreadable", canReset: false },
        {},
      ),
    ).toBeUndefined();
  });

  it("treats a host-owned plugin outside the catalog as installed", () => {
    expect(
      pluginLinkProblem(link("buzz.core", "gone"), ready([]), {
        "buzz.core": { revision: "bundled", status: "active", error: null },
      }),
    ).toEqual({ reason: "no-page", name: "buzz.core", pageId: "gone" });
  });
});
