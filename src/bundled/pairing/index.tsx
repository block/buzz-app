import type { PluginModule } from "../../plugins/api";
import { PairingSettings } from "./PairingSettings";
export const inject = ["settingsCards", "communityReader"];
export const apply: PluginModule["apply"] = (ctx) => {
  const communities = ctx.communityReader;
  ctx.settingsCards.register({
    id: "mobile",
    title: "Pair mobile",
    group: "Account",
    component: ({ active }) => (
      <PairingSettings communities={communities} active={active} />
    ),
  });
};
