import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
export const inject = ["pages", "relay", "agentControl"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    component: () => <AgentsPage relay={relay} control={control} />,
  });
};
