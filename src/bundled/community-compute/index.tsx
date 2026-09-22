import type { PluginModule } from "../../plugins/api";
import { computeLauncherIcon } from "../../shared/design-system/icons/svg";
import { CommunityComputePage } from "./CommunityComputePage";

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.panels.register({
    id: "compute",
    title: "Compute",
    matches: () => false,
    launcher: { icon: computeLauncherIcon, target: "" },
    component: () => <CommunityComputePage relay={relay} />,
  });
};
