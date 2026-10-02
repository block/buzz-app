import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { editAgentRoute } from "./edit-route";
import { LiveRunsAccessory } from "./LiveRunsAccessory";
export const inject = [
  "pages",
  "relay",
  "agentControl",
  "agentTypes",
  "navigation",
  "communityReader",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  const agentTypes = ctx.agentTypes;
  const communities = ctx.communityReader;
  ctx.conversation.registerAccessory({
    id: "live-runs",
    title: "Agent runs",
    // After the activity rows, directly above the composer.
    order: 1,
    component: (props) => (
      <LiveRunsAccessory {...props} runs={agentTypes.runs} />
    ),
  });
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
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
        agentTypes={agentTypes}
        open={ctx.navigation.open}
        communities={communities}
      />
    ),
  });
};
