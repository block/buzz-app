import { MentionCompletion } from "./MentionCompletion";
import { mentionQuery } from "./mention-query";
import type { PluginModule } from "../../plugins/api";
import { MentionPicker } from "./MentionPicker";
import {
  TaskSkillCompletion,
  skillQuery,
} from "../../features/solo/task-skill-completion";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCompletion({
    id: "typeahead",
    title: "Mention",
    order: -10,
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  });
  ctx.conversation.registerCompletion({
    id: "task-skills",
    title: "Skills",
    match: ({ text, start }) => skillQuery(text, start),
    component: TaskSkillCompletion,
  });
  ctx.conversation.registerTool({
    id: "picker",
    title: "Mentions",
    order: -10,
    component: ({
      session,
      scope,
      channelId,
      disabled,
      insertMention,
      insertMentions,
      inviteAgents,
      audience,
      focus,
    }) => (
      <MentionPicker
        session={session}
        scope={scope}
        channelId={channelId}
        disabled={disabled}
        inviteAgents={inviteAgents}
        audience={audience}
        select={insertMention}
        selectTeam={insertMentions}
        focusDraft={focus}
      />
    ),
  });
};
