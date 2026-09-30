import { createRetainedSessions } from "./retained-sessions";
import { SessionActivityDetail } from "./SessionActivityDetail";
import { PersonalSessions } from "./PersonalSessions";
import type { PluginModule } from "../../plugins/api";
import { NewChannelSession } from "./NewChannelSession";
import { RecentChannelThreads } from "./RecentChannelThreads";
import { SessionsPage } from "./SessionsPage";

export const inject = ["pages", "relay", "conversation", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const extensions = ctx.conversation;
  const navigator = ctx.navigation;
  const retained = createRetainedSessions();
  ctx.effect(() => () => retained.dispose());
  extensions.registerChannelDirectory({
    id: "sessions",
    title: "Sessions",
    component: (props) => <RecentChannelThreads {...props} owner={retained} />,
    threadAccessory: SessionActivityDetail,
    sidebar: (props) => <PersonalSessions {...props} owner={retained} />,
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
