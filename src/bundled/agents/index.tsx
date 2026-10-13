import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { ClassifierSettings } from "./ClassifierSettings";

export const inject = ["pages", "agents", "relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, relay } = ctx;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    component: () => <AgentsPage agents={agents} relay={relay} />,
  });
  ctx.settingsCards.register({
    id: "jev-classifier",
    title: "Jev classifier",
    group: "Integrations",
    component: ({ active }) => (
      <ClassifierSettings agents={agents} active={active} />
    ),
  });
};
