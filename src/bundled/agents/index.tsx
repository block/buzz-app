import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { editAgentRoute } from "./edit-route";
export const inject = [
  "pages",
  "panels",
  "relay",
  "agentControl",
  "navigation",
  "communityReader",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  const communities = ctx.communityReader;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    companion: true,
    primary: true,
    handlesNavigation: true,
    route: {
      version: 1,
      validate: (params) => editAgentRoute(params) !== null,
    },
    component: (props) => (
      <AgentsPage
        {...props}
        relay={relay}
        control={control}
        panels={ctx.panels}
        open={ctx.navigation.open}
        communities={communities}
      />
    ),
  });
};
