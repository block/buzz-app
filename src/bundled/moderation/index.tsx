import type { PluginModule } from "../../plugins/api";
import { CommunityAdmin } from "./CommunityAdmin";

export const inject = ["relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.settingsCards.register({
    id: "invites",
    title: "Invites",
    group: "Communities",
    component: ({ active }) => <CommunityAdmin relay={relay} active={active} />,
  });
};
