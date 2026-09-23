import { createAgentDirectory } from "./directory";
import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
export const inject = ["pages", "relay", "agentControl", "identityNames"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  ctx.identityNames.register(createAgentDirectory(control));
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    component: () => <AgentsPage relay={relay} control={control} />,
  });
};
