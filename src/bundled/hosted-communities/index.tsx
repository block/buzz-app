import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { HostedCommunities } from "./HostedCommunities";

export const inject = ["settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Community actions still require the browser development broker.
  // Desktop sign-in belongs to the optional Builderlab plugin.
  if (isTauri()) return;
  ctx.settingsCards.register({
    id: "hosted",
    title: "Hosted communities",
    group: "Communities",
    component: HostedCommunities,
  });
};
