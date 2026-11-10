import type { PluginModule } from "../../plugins/api";
import { AgentUiBlock } from "./AgentUiBlock";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCodeBlock({
    id: "agent-ui",
    title: "Agent card",
    matches: (language) => language === "buzz-ui",
    component: AgentUiBlock,
  });
};
