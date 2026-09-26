import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { editAgentRoute } from "./edit-route";
export const inject = [
  "pages",
  "relay",
  "agentControl",
  "navigation",
  "agentProviders",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
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
        providers={ctx.agentProviders}
        open={ctx.navigation.open}
      />
    ),
  });
};
