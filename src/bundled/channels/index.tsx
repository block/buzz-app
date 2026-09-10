import type { PluginModule } from "../../plugins/api";
import { ChannelsPage } from "./ChannelsPage";
export const inject = ["pages", "relay", "panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const panels = ctx.panels;
  ctx.pages.register({
    id: "channels",
    title: "Channels",
    layout: "workspace",
    companion: true,
    component: ({ companion }) => (
      <ChannelsPage relay={relay} panels={panels} companion={companion} />
    ),
  });
};
