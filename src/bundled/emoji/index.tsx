import type { PluginModule } from "../../plugins/api";
import type {
  ComposerToolProps,
  InlineContent,
} from "../../features/conversation/contracts";
import { emojiMatches } from "../../features/relay/emoji";
import { EmojiPicker } from "./EmojiPicker";
import { CustomEmoji } from "./CustomEmoji";

export const inject = ["conversation"];
const entries = (content: InlineContent) =>
  content.reaction
    ? content.reaction.emoji
      ? [content.reaction.emoji]
      : []
    : (content.message.emoji ?? []);
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerTool({
    id: "picker",
    title: "Emoji",
    component: ({
      session,
      scope,
      disabled,
      insertText,
    }: ComposerToolProps) => (
      <EmojiPicker
        session={session}
        scope={scope}
        disabled={disabled}
        insert={insertText}
      />
    ),
  });
  ctx.conversation.registerInline({
    id: "custom",
    title: "Custom emoji",
    matches: (content) => [...emojiMatches(content.text, entries(content))],
    component: ({ text, content, media }) => {
      const emoji = entries(content).find(
        (entry) => `:${entry.shortcode}:` === text.toLowerCase(),
      );
      return emoji ? <CustomEmoji emoji={emoji} media={media} /> : text;
    },
  });
};
