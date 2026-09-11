import type { PluginModule } from "../../plugins/api";
import { ChannelsPage } from "./ChannelsPage";
export const inject = [
  "pages",
  "relay",
  "panels",
  "conversation",
  "navigation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const extensions = ctx.conversation;
  const relay = ctx.relay;
  const panels = ctx.panels;
  const navigator = ctx.navigation;
  ctx.pages.register({
    id: "channels",
    title: "Channels",
    layout: "workspace",
    companion: true,
    handlesNavigation: true,
    component: ({ companion, navigation }) => (
      <ChannelsPage
        navigation={navigation}
        navigator={navigator}
        extensions={extensions}
        relay={relay}
        panels={panels}
        companion={companion}
      />
    ),
  });
};
