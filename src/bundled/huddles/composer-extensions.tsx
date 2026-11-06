import type {
  ConversationExtensions,
  ComposerTool,
  ComposerCompletion,
} from "../../features/conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import type { GifRequests } from "../../features/relay/gifs";
import { EmojiPicker } from "../emoji/EmojiPicker";
import { createReactionPicker } from "../emoji/ReactionPicker";
import { EmojiCompletion } from "../emoji/EmojiCompletion";
import { emojiQuery } from "../emoji/emoji-query";
import { MentionPicker } from "../mentions/MentionPicker";
import { MentionCompletion } from "../mentions/MentionCompletion";
import { mentionQuery } from "../mentions/mention-query";
import { ChannelCompletion } from "../channels/ChannelCompletion";
import { channelQuery } from "../channels/channel-query";
import { ResourcePicker } from "../repos/ResourcePicker";
import { voiceRecorderTool } from "../voice-notes/recorder-tool";

/** Native companions reuse bundled tools only while their main-app contribution is enabled. */
const tools = (
  gifRequests?: GifRequests,
  capture = false,
): Record<string, ComposerTool> => ({
  "buzz.emoji/picker": {
    id: "picker",
    title: "Emoji",
    component: ({ session, scope, disabled, insertText }) => (
      <EmojiPicker
        session={session}
        scope={scope}
        gifRequests={gifRequests}
        disabled={disabled}
        insert={insertText}
      />
    ),
    // Pop-out windows react with the same picker the main window uses.
    reactionComponent: createReactionPicker(),
  },
  "buzz.mentions/picker": {
    id: "picker",
    title: "Mentions",
    order: -10,
    component: ({
      session,
      scope,
      channelId,
      disabled,
      inviteAgents,
      insertMention,
    }) => (
      <MentionPicker
        session={session}
        scope={scope}
        channelId={channelId}
        disabled={disabled}
        inviteAgents={inviteAgents}
        select={insertMention}
      />
    ),
  },
  "buzz.repos/resources": {
    id: "resources",
    title: "Issues and pull requests",
    component: ResourcePicker,
  },
  // A window that may capture records in its own webview; main converts and
  // uploads the note like any companion attachment. Huddles never capture.
  ...(capture ? { "buzz.voice-notes/recorder": voiceRecorderTool } : {}),
});
const completions: Record<string, ComposerCompletion> = {
  "buzz.emoji/typeahead": {
    id: "typeahead",
    title: "Emoji",
    order: 0,
    match: ({ text, start }) => emojiQuery(text, start),
    component: EmojiCompletion,
  },
  "buzz.mentions/typeahead": {
    id: "typeahead",
    title: "Mention",
    order: -10,
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  },
  "buzz.channels/channel-typeahead": {
    id: "channel-typeahead",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: ChannelCompletion,
  },
};
export function huddleComposerExtensions(enabled: {
  tools: readonly string[];
  completions: readonly string[];
  gifRequests?: GifRequests;
  /** This window may record voice notes (pop-outs; never the Huddle). */
  capture?: boolean;
}): ConversationExtensions {
  function reader<T>(catalog: Record<string, T>, keys: readonly string[]) {
    const entries: Contribution<T>[] = keys.flatMap((key) =>
      catalog[key]
        ? [
            {
              ...catalog[key],
              key,
              pluginId: key.split("/")[0] ?? "",
              revision: "bundled",
            },
          ]
        : [],
    );
    return { snapshot: () => entries, subscribe: () => () => {} };
  }
  return {
    tools: reader(tools(enabled.gifRequests, enabled.capture), enabled.tools),
    completions: reader(completions, enabled.completions),
    inline: reader({}, []),
  };
}
