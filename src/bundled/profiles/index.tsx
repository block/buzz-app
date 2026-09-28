import { parseInstanceTarget } from "../../features/profiles/instance-target";
import { InstanceProfilePanel } from "./InstanceProfilePanel";
import type { PluginModule } from "../../plugins/api";
import { profileKey } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";

export const inject = ["panels", "relay", "navigation", "agentControl"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "profile",
    title: "Profile",
    matches: (target) => !!profileKey(target) || !!parseInstanceTarget(target),
    component: (props) => {
      const instance = parseInstanceTarget(props.target);
      return instance ? (
        <InstanceProfilePanel
          {...props}
          instance={instance}
          relay={ctx.relay}
          navigation={ctx.navigation}
          control={ctx.agentControl}
        />
      ) : (
        <ProfilePanel
          {...props}
          relay={ctx.relay}
          navigation={ctx.navigation}
          control={ctx.agentControl}
        />
      );
    },
  });
};
