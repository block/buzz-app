import type { PluginModule } from "../../plugins/api";
import { createPulsePositions, validPulseRoute } from "./navigation";
import { PulsePage } from "./PulsePage";
export const inject = ["pages", "relay", "conversation", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  const extensions = ctx.conversation;
  const positions = createPulsePositions();
  ctx.pages.register({
    id: "pulse",
    title: "Pulse",
    layout: "workspace",
    companion: true,
    handlesNavigation: true,
    route: { version: 1, validate: validPulseRoute },
    component: ({ companion, navigation }) => (
      <PulsePage
        positions={positions}
        navigator={navigator}
        navigation={navigation}
        relay={relay}
        extensions={extensions}
        companion={companion}
      />
    ),
  });
};
