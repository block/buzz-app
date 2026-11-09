import type { PluginModule } from "../../plugins/api";

/** PROTOTYPE: swaps the Messages sidebar for the Activity sidebar while on.
 * Turning the plugin off brings the original sidebar back. */
export const inject = ["sidebarScope"];

export const apply: PluginModule["apply"] = (ctx) => {
  ctx.sidebarScope.replaceSidebar?.({
    id: "activity-sidebar",
    sidebar: "activity",
  });
};
