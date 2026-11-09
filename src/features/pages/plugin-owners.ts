import type { ConfigurationState } from "../../plugins/types";
import type { PluginOwners } from "./ContributionFailure";

/** Names the external plugins in the saved catalog, so a failed page or panel
 * can name its own plugin and open its management UI. Built-in plugins, unknown
 * IDs, and a catalog that hasn't loaded all resolve to undefined. */
export function pluginOwners(
  configuration: ConfigurationState,
  manage: (pluginId: string) => void,
): PluginOwners {
  return (pluginId) => {
    const info =
      configuration.status === "ready"
        ? configuration.catalog.plugins.find(
            (plugin) => plugin.manifest.id === pluginId,
          )
        : undefined;
    return info?.source === "external"
      ? { name: info.manifest.name, manage: () => manage(pluginId) }
      : undefined;
  };
}
