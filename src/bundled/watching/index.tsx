import type { PluginModule } from "../../plugins/api";
import { createTab } from "./Tab";

export const inject = ["agents", "relay", "navigation"];
export const apply: PluginModule["apply"] = ({ agents, relay, navigation }) => {
  agents.registerTab({
    id: "watching",
    title: "Watching",
    component: createTab({ agents, relay, navigation }),
  });
};
