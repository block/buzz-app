import type { PluginModule } from "../../plugins/api";
import { InventoryPage } from "./InventoryPage";
export const inject = ["pages", "relay", "agentControl", "communityReader"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  const communities = ctx.communityReader;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    component: () => (
      <InventoryPage
        relay={relay}
        control={control}
        communities={communities}
      />
    ),
  });
};
