import type { PluginModule } from "../../plugins/api";
import { CommunityAdmin } from "./CommunityAdmin";
import { canManageMembership, createCommunityMembership } from "./membership";

export const inject = ["relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const membership = createCommunityMembership(relay);
  ctx.effect(() => () => membership.dispose());
  ctx.settingsCards.register({
    id: "membership",
    title: "Membership",
    section: "administration",
    visibility: {
      snapshot: () => canManageMembership(membership.snapshot()),
      subscribe: membership.subscribe,
      ensure: membership.ensure,
    },
    component: ({ active, community }) => (
      <CommunityAdmin
        relay={relay}
        membership={membership}
        {...(community ? { communityName: community.name } : {})}
        active={active}
      />
    ),
  });
};
