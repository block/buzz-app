import { importAttention } from "../../features/agents/attention-import";
import { registerAttention } from "../../features/agents/attention-command";
import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { availableAgentProviderRoute } from "./routes";

export const inject = ["pages", "agents", "relay", "navigation", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, relay, navigation: navigator } = ctx;
  registerAttention(ctx);
  ctx.effect(() => {
    if (!ctx.host.spawn) return () => {};
    let started = false;
    const migrate = () => {
      if (started || agents.snapshot().status !== "ready") return;
      started = true;
      void importAttention(agents, ctx.host).catch((error) =>
        console.warn("Attention migration failed", error),
      );
    };
    const unsubscribe = agents.subscribe(migrate);
    migrate();
    return unsubscribe;
  });
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
