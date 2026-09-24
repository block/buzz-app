import type { PluginModule } from "../../plugins/api";
import { profileKey } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";

export const inject = ["panels", "relay", "navigation", "agentControl"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "profile",
    title: "Profile",
    matches: (target) => !!profileKey(target),
    component: (props) => (
      <ProfilePanel
        {...props}
        relay={ctx.relay}
        navigation={ctx.navigation}
        control={ctx.agentControl}
      />
    ),
  });
};
