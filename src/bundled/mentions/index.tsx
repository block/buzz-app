import type { PluginModule } from "../../plugins/api";
import { MentionPicker } from "./MentionPicker";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerTool({
    id: "picker",
    title: "Mentions",
    order: -10,
    component: ({ session, channelId, disabled, insertMention }) => (
      <MentionPicker
        session={session}
        channelId={channelId}
        disabled={disabled}
        select={insertMention}
      />
    ),
  });
};
