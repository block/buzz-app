import type { PluginModule } from "../../plugins/api";
import { splitPartition } from "../../features/relay/partition";
import { SECTION_CAP } from "../../features/channel-navigation/conversation-sections";
import { stepRecent, recentConversations, recentIds } from "./recent";

export const inject = ["relay", "navigation", "conversation", "shortcuts"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  ctx.conversation.registerConversationSection({
    id: "recent",
    title: "Recent",
    channels: recentIds,
  });
  const go = (step: 1 | -1) => {
    const { scope: partition, session } = relay.snapshot();
    const scope = partition && splitPartition(partition);
    if (!scope) return;
    const { target } = navigator.snapshot().entry;
    const item = stepRecent(
      recentConversations(session),
      target.kind === "conversation" ? target.channelId : undefined,
      SECTION_CAP,
      step,
    );
    if (item)
      void navigator.open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: item.channelId,
        ...(item.messageId && { messageId: item.messageId }),
        ...(item.rootId && { threadRootId: item.rootId }),
      });
  };
  for (const [id, title, key, step, order] of [
    ["next-recent-conversation", "Next recent conversation", "d", 1, 10],
    [
      "previous-recent-conversation",
      "Previous recent conversation",
      "u",
      -1,
      11,
    ],
  ] as const)
    ctx.shortcuts.register({
      id,
      title,
      binding: { key, mod: true },
      order,
      allowInEditable: true,
      when: () => !!relay.snapshot().scope,
      run: () => go(step),
    });
};
