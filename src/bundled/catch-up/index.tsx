import type { PluginModule } from "../../plugins/api";
import { CatchUpPage } from "./CatchUpPage";

export const inject = ["pages", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "catch-up",
    title: "Catch up",
    primary: true,
    layout: "workspace",
    component: () => (
      <CatchUpPage relay={ctx.relay} navigator={ctx.navigation} />
    ),
  });
};
