import type { PluginModule } from "../../plugins/api";
import { HostedCommunities } from "./HostedCommunities";

export const inject = ["settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.settingsCards.register({
    id: "hosted",
    title: "Hosted communities",
    group: "Communities",
    component: HostedCommunities,
  });
};
