import type { PluginModule } from "../../plugins/api";
import { NewChannelSession } from "./NewChannelSession";
import { RecentChannelThreads } from "./RecentChannelThreads";
import { SessionsPage } from "./SessionsPage";

export const inject = ["pages", "relay", "conversation", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const extensions = ctx.conversation;
  const navigator = ctx.navigation;
  extensions.registerChannelDirectory({
    id: "sessions",
    title: "Sessions",
    component: RecentChannelThreads,
    create: {
      title: "New session",
      component: (props) => (
        <NewChannelSession {...props} extensions={extensions} />
      ),
    },
  });
  ctx.pages.register({
    id: "sessions",
    title: "Sessions",
    layout: "workspace",
    component: () => (
      <SessionsPage
        relay={relay}
        extensions={extensions}
        navigator={navigator}
      />
    ),
  });
};
