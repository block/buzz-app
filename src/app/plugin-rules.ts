import type { AdminAccessState } from "../bundled/admin-access";
import performanceDiagnosticsManifest from "../bundled/performance-diagnostics/manifest.json";
import type { PluginInfo } from "../plugins/types";

// Which plugins Settings → Plugins lists, and which of them can be switched
// on or off right now.

/** Channels is the app's sidebar; it has no enable/disable control. */
export function isRequiredPlugin(plugin: PluginInfo) {
  return plugin.manifest.id === "buzz.channels";
}

/** Plugins people choose to turn on. Diagnostics are offered through agent
 * requests instead. */
export function listedPlugin(plugin: PluginInfo) {
  return !(
    plugin.source === "bundled" &&
    plugin.manifest.id === performanceDiagnosticsManifest.id
  );
}

/** Bundled plugins that need community or relay access to turn on. */
const RESTRICTED_PLUGINS = ["buzz.moderation", "buzz.relay-staff"];
export function restrictedPlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    RESTRICTED_PLUGINS.includes(plugin.manifest.id)
  );
}

export function accessMessage(plugin: PluginInfo, state: AdminAccessState) {
  switch (state) {
    case "allowed":
      return null;
    case "checking":
      return "Checking access…";
    case "no-community":
      return "Select a community to check access.";
    case "error":
      return "Could not check access. Open details to try again.";
    case "unavailable":
      return "Access is unavailable in this build or on this relay.";
    case "denied":
      return plugin.manifest.id === "buzz.moderation"
        ? "Select a community where you’re an owner or admin."
        : "Select a community on a relay where you have staff access.";
  }
}

export function pluginToggleDisabled(
  plugin: PluginInfo,
  access: AdminAccessState,
  busy: boolean,
) {
  return (
    busy ||
    (!plugin.enabled && restrictedPlugin(plugin) && access !== "allowed")
  );
}
