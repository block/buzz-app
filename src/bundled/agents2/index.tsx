import type { PluginModule } from "../../plugins/api";
import { Agents2Page } from "./Agents2Page";
import { ClassifierSettings } from "./ClassifierSettings";

export const inject = ["pages", "agents2", "relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents2, relay } = ctx;
  ctx.pages.register({
    id: "agents2",
    title: "Agents2",
    layout: "workspace",
    primary: true,
    component: () => <Agents2Page agents2={agents2} relay={relay} />,
  });
  ctx.settingsCards.register({
    id: "jev-classifier",
    title: "Jev classifier",
    group: "Integrations",
    component: ({ active }) => (
      <ClassifierSettings agents2={agents2} active={active} />
    ),
  });
};
