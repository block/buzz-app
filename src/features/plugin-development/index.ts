import type { Context } from "@deepseek-ai/cordis";
import type { BundledPlugin, PluginManager } from "../../plugins/manager";
import manifest from "./manifest.json";
import { registerPluginDevelopmentTools } from "./agent-tools";

/** The host-owned feature that adds the plugin development agent tools. It
 * reads the plugin manager through `plugins`, never a Cordis service, so no
 * installed plugin can inject plugin management. */
export function pluginDevelopment(plugins: () => PluginManager): BundledPlugin {
  return {
    manifest: { ...manifest, apiVersion: 1 },
    module: {
      inject: ["agents", "pages", "panels", "sidebarSections"],
      apply(ctx: Context) {
        const { agents, pages, panels } = ctx;
        const sections = ctx.sidebarSections;
        registerPluginDevelopmentTools({
          plugins,
          agents,
          registered: () => ({
            pages: pages.snapshot(),
            panels: panels.snapshot(),
            sidebarSections: sections?.snapshot() ?? [],
            // Agents lists them as tools; each is a contribution keyed by name.
            agentTools: agents.tools().map((tool) => ({
              id: tool.name,
              pluginId: (tool as { pluginId?: string }).pluginId ?? "",
            })),
          }),
        });
      },
    },
  };
}
