import type { AdminAccessState } from "../bundled/admin-access";
import type { PluginInfo } from "./types";

export function isRequiredPlugin(plugin: PluginInfo) {
  return plugin.manifest.id === "buzz.channels";
}

export function restrictedPlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.id === "buzz.moderation" ||
      plugin.manifest.id === "buzz.relay-staff")
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
