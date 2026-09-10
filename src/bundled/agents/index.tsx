import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
export const inject = ["pages", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    component: () => <AgentsPage relay={relay} />,
  });
};
