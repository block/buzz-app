import type { PluginModule } from "../../plugins/api";
import { AgentChannelsPage } from "./AgentChannelsPage";

export const inject = ["pages", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.pages.register({
    id: "agent-channels",
    title: "Agent channels",
    layout: "workspace",
    component: () => <AgentChannelsPage relay={relay} />,
  });
};
