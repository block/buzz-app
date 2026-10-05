import type { PluginModule } from "../../plugins/api";
import { InboxPage } from "./InboxPage";
export const inject = ["pages", "relay", "navigation", "conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  ctx.pages.register({
    id: "inbox",
    title: "Inbox",
    layout: "workspace",
    primary: true,
    component: () => (
      <InboxPage
        relay={relay}
        navigator={navigator}
        extensions={ctx.conversation}
      />
    ),
  });
};
