import { createAgentDirectory } from "./directory";
import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
export const inject = [
  "pages",
  "relay",
  "agentControl",
  "identityNames",
  "communityReader",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  const communities = ctx.communityReader;
  ctx.identityNames.register(createAgentDirectory(control));
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    component: () => (
      <AgentsPage relay={relay} control={control} communities={communities} />
    ),
  });
};
