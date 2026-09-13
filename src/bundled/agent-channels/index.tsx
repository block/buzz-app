import type { PluginModule } from "../../plugins/api";
import { AgentChannelsPage } from "./AgentChannelsPage";

export const inject = ["pages", "relay", "objects"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const objects = ctx.objects;
  ctx.pages.register({
    id: "agent-channels",
    title: "Agent dashboard",
    layout: "workspace",
    component: () => <AgentChannelsPage relay={relay} objects={objects} />,
  });
};
