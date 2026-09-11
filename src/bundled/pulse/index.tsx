import type { PluginModule } from "../../plugins/api";
import { PulsePage } from "./PulsePage";
export const inject = ["pages", "relay", "conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const extensions = ctx.conversation;
  ctx.pages.register({
    id: "pulse",
    title: "Pulse",
    layout: "workspace",
    companion: true,
    component: ({ companion }) => (
      <PulsePage relay={relay} extensions={extensions} companion={companion} />
    ),
  });
};
