import { MentionCompletion } from "./MentionCompletion";
import { mentionQuery } from "./mention-query";
import type { PluginModule } from "../../plugins/api";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCompletion({
    id: "typeahead",
    title: "Mention",
    order: -10,
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  });
};
