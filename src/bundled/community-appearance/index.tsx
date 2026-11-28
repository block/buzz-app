import type { PluginModule } from "../../plugins/api";
import { ImageIcon } from "../../shared/design-system/icons";
import { adminCardVisibility } from "../moderation/membership";
import { CommunityIcon } from "./CommunityIcon";

export const inject = ["relay", "settingsCards", "adminAccess"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.settingsCards.register({
    id: "community-icon",
    title: "Community icon",
    icon: ImageIcon,
    section: "administration",
    visibility: adminCardVisibility(relay, ctx.adminAccess.membership),
    component: ({ active, community }) => (
      <CommunityIcon
        relay={relay}
        communityName={community?.name}
        active={active}
      />
    ),
  });
};
