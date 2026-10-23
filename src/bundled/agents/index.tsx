import { watchAttentionImport } from "../../features/agents/attention-import";
import { registerAttention } from "../../features/agents/attention-command";
import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { AttentionPage } from "./AttentionPage";
import { availableAgentProviderRoute } from "./routes";

export const inject = ["pages", "agents", "relay", "navigation", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, relay, navigation: navigator } = ctx;
  registerAttention(ctx);
  ctx.pages.register({
    id: "attention",
    title: "Attention",
    layout: "workspace",
    primary: true,
    component: () => <AttentionPage agents={agents} relay={relay} />,
  });
  ctx.effect(() => watchAttentionImport(agents, ctx.host));
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: availableAgentProviderRoute,
    },
    component: ({ navigation }) => (
      <AgentsPage
        agents={agents}
        relay={relay}
        navigator={navigator}
        {...(navigation ? { navigation } : {})}
      />
    ),
  });
};
