import type { PluginModule } from "../../plugins/api";
import { SwitchboardPage } from "./SwitchboardPage";
export const inject = ["pages", "relay", "navigation", "agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "switchboard",
    title: "Switchboard",
    layout: "workspace",
    primary: true,
    component: () => (
      <SwitchboardPage
        relay={ctx.relay}
        agents={ctx.agents}
        navigator={ctx.navigation}
      />
    ),
  });
};
