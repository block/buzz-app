import type { PluginModule } from "../../plugins/api";
import { SessionsPage } from "../sessions/SessionsPage";
import { isMeRoute } from "./routes";

export const inject = ["pages", "relay", "conversation", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const extensions = ctx.conversation;
  const navigator = ctx.navigation;
  ctx.pages.register({
    id: "me",
    title: "Me",
    primary: true,
    placement: "topbar",
    layout: "workspace",
    route: { version: 1, validate: isMeRoute },
    component: ({ navigation }) => (
      <div className="flex h-full min-h-0 flex-col">
        <SessionsPage
          relay={relay}
          extensions={extensions}
          navigator={navigator}
          navigation={navigation}
        />
      </div>
    ),
  });
};
