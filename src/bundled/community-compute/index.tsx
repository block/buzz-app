import type { PluginModule } from "../../plugins/api";
import { CommunityComputePage } from "./CommunityComputePage";

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.panels.register({
    id: "compute",
    title: "Compute",
    matches: () => false,
    component: () => <CommunityComputePage relay={relay} />,
  });
};
