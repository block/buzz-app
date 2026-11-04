import { createGifShortcut } from "./gif-shortcut";
import { EmojiCompletion } from "./EmojiCompletion";
import { emojiQuery } from "./emoji-query";
import type { PluginModule } from "../../plugins/api";
import type {
  ComposerToolProps,
  InlineContent,
} from "../../features/conversation/contracts";
import { emojiMatches } from "../../features/relay/emoji";
import { createReactionPicker } from "./ReactionPicker";
import { EmojiPicker } from "./EmojiPicker";
import { CustomEmoji } from "./CustomEmoji";
import { copyEmoji } from "./copy-emoji";
import { CustomEmojiSettings } from "./CustomEmojiSettings";
import { StickerDialog, stickerSource } from "./StickerDialog";
import {
  SmileyIcon,
  SmileyStickerIcon,
} from "../../shared/design-system/icons";

export const inject = ["conversation"];
const entries = (content: InlineContent) =>
  content.reaction
    ? content.reaction.emoji
      ? [content.reaction.emoji]
      : []
    : (content.message.emoji ?? []);
export const apply: PluginModule["apply"] = (ctx) => {
  const gifShortcut = createGifShortcut();
  ctx.inject(["shortcuts"], (scope) => {
    scope.shortcuts.register({
      id: "gif-picker",
      title: "Open GIF picker",
      binding: { key: "g", mod: true },
      allowInEditable: true,
      when: gifShortcut.available,
      run: gifShortcut.run,
    });
  });
  // Authoring needs a relay host; conversation-only hosts still get the palette.
  ctx.inject(["relay", "settingsCards"], (scope) => {
    const relay = scope.relay;
    scope.settingsCards.register({
      id: "custom-emoji",
      title: "Custom emoji",
      icon: SmileyIcon,
      component: ({ active }) => (
        <CustomEmojiSettings relay={relay} active={active} />
      ),
    });
  });
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("copy", copyEmoji);
    return () => document.removeEventListener("copy", copyEmoji);
  });
  ctx.conversation.registerCompletion({
    id: "typeahead",
    title: "Emoji",
    order: 0,
    match: (observation) => emojiQuery(observation.text, observation.start),
    component: EmojiCompletion,
  });
  ctx.conversation.registerTool({
    id: "picker",
    title: "Emoji",
    reactionComponent: createReactionPicker(),
    component: ({
      session,
      scope,
      disabled,
      insertText,
    }: ComposerToolProps) => (
      <EmojiPicker
        gifShortcut={gifShortcut}
        session={session}
        scope={scope}
        disabled={disabled}
        insert={insertText}
      />
    ),
  });
  ctx.conversation.registerMessageAction({
    id: "make-sticker",
    title: "Make sticker",
    icon: () => <SmileyStickerIcon size={16} aria-hidden="true" />,
    matches: (message, session) =>
      !!stickerSource(message) &&
      !!session.emoji.add &&
      !!session.emoji.upload &&
      (!message.delivery || ["accepted", "seen"].includes(message.delivery)),
    component: StickerDialog,
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
