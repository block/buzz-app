import { useState } from "react";
import { EmojiPicker } from "../../emoji/EmojiPicker";
import { MentionPicker } from "../../mentions/MentionPicker";
import { MentionCompletion } from "../../mentions/MentionCompletion";
import { mentionQuery } from "../../mentions/mention-query";
import type {
  ComposerTool,
  ComposerCompletion,
  ConversationExtensions,
} from "../../../features/conversation/contracts";
import type { MessageComposerProps } from "../../../features/messages/MessageComposer";
import type { RelaySession } from "../../../features/relay/session";
import type { Contribution } from "../../../plugins/contributions";
import { writeView } from "../../../shared/view-state";

const empty = () => () => {};
const alice = "a".repeat(64);
const honey = "b".repeat(64);
const otherAlice = "c".repeat(64);
const otherHoney = "d".repeat(64);
const profiles = new Map([
  [alice, { name: "Alice" }],
  [honey, { name: "Honey", isAgent: true as const }],
  [otherAlice, { name: "Alice" }],
  [otherHoney, { name: "Honey", isAgent: true as const }],
]);
const emptyList: readonly never[] = [];
const emojiSnapshot = { status: "ready" as const, entries: emptyList };
const channelList = {
  status: "ready" as const,
  channels: [
    {
      id: "buzz-design",
      name: "buzz-design",
      members: [alice, honey, otherAlice, otherHoney],
    },
  ],
};
const library = { status: "ready" as const, identities: [] };
const session = {
  messages: {
    send: () => "preview-send",
    reply: () => "preview-reply",
  },
  typing: { snapshot: () => emptyList, subscribe: empty },
  profiles: {
    snapshot: () => profiles,
    subscribe: empty,
    ensure: async () => undefined,
  },
  channels: {
    list: () => channelList,
    subscribeList: empty,
    ensureList: () => {},
    refreshList: () => {},
  },
  agentLibrary: { snapshot: () => library, subscribe: empty },
  emoji: {
    snapshot: () => emojiSnapshot,
    subscribe: empty,
    ensure: async () => undefined,
    refresh: async () => undefined,
  },
  media: (url: string) => url,
  outbox: { supports: () => true },
} as unknown as RelaySession;

const tools: readonly Contribution<ComposerTool>[] = [
  {
    id: "mentions",
    key: "buzz.mentions/picker",
    pluginId: "buzz.mentions",
    revision: "preview",
    title: "Mentions",
    order: -10,
    component: ({ session, scope, channelId, disabled, insertMention }) => (
      <MentionPicker
        session={session}
        scope={scope}
        channelId={channelId}
        disabled={disabled}
        select={insertMention}
      />
    ),
  },
  {
    id: "emoji",
    key: "buzz.emoji/picker",
    pluginId: "buzz.emoji",
    revision: "preview",
    title: "Emoji",
    component: ({ session, scope, disabled, insertText }) => (
      <EmojiPicker
        session={session}
        scope={scope}
        disabled={disabled}
        insert={insertText}
      />
    ),
  },
];
const completions: readonly Contribution<ComposerCompletion>[] = [
  {
    id: "typeahead",
    key: "buzz.mentions/typeahead",
    pluginId: "buzz.mentions",
    revision: "preview",
    title: "Mention",
    order: -10,
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  },
];
const extensions: ConversationExtensions = {
  tools: { snapshot: () => tools, subscribe: empty },
  inline: { snapshot: () => emptyList, subscribe: empty },
  completions: { snapshot: () => completions, subscribe: empty },
};

let sequence = 0;
export function useComposerFixture(
  options: Partial<MessageComposerProps> & { initialDraft?: string } = {},
): MessageComposerProps {
  const [scope] = useState(() => `product-composer-${sequence++}`);
  const { initialDraft, ...props } = options;
  useState(() => {
    if (initialDraft !== undefined)
      writeView(
        scope,
        `draft:${props.channelId ?? "buzz-design"}`,
        initialDraft,
      );
  });
  return {
    session,
    extensions,
    scope,
    channelId: "buzz-design",
    channelName: "buzz-design",
    ...props,
  };
}
