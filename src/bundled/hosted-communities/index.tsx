import type { PluginModule } from "../../plugins/api";
import { HostedCommunities } from "./HostedCommunities";
import { GlobeIcon } from "../../shared/design-system/icons";

export const inject = ["settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.settingsCards.register({
    id: "hosted",
    title: "Hosted communities",
    icon: GlobeIcon,
    group: "Communities",
    component: HostedCommunities,
  });
};
