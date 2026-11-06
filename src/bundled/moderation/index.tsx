import type { PluginModule } from "../../plugins/api";
import { CommunityAdmin } from "./CommunityAdmin";
import { canManageMembership } from "./membership";
import { WelcomeSettings } from "./WelcomeSettings";

export const inject = [
  "relay",
  "settingsCards",
  "adminAccess",
  "communityReader",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const membership = ctx.adminAccess.membership;
  const manageable = () => {
    const connection = relay.snapshot();
    const state = membership.snapshot();
    if (canManageMembership(state)) return true;
    if (
      connection.status === "error" ||
      connection.status === "disconnected" ||
      state.error
    )
      return "error";
    if (
      state.status === "idle" ||
      state.status === "loading" ||
      state.refreshing
    )
      return "pending";
    return false;
  };
  // Registered in every build. The card hides unsupported member changes
  // itself, so a Settings section, history entry or in-app locator naming it
  // still opens the roster and invite controls in native builds.
  ctx.settingsCards.register({
    id: "membership",
    title: "Membership",
    section: "administration",
    visibility: {
      snapshot: manageable,
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
  // Owners and admins set the welcome and starter channels. The card itself
  // keeps the welcome form to relays that support it. The message editor
  // shows pasted links through the conversation's link renderers, as the
  // card does.
  ctx.settingsCards.register({
    id: "welcome",
    title: "Welcome",
    section: "administration",
    visibility: {
      snapshot: manageable,
      subscribe: membership.subscribe,
      ensure: membership.ensure,
    },
    component: ({ active }) => (
      <WelcomeSettings
        relay={relay}
        communities={ctx.communityReader}
        active={active}
        extensions={ctx.conversation}
      />
    ),
  });
};
