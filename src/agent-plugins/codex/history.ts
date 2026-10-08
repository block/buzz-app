import type { EventData, ReadFilter } from "../../features/relay/events";
import { foldMessages } from "../../features/relay/fold";
import type { Conversation } from "./prompt";

/** Reuse the message owner's edits/deletions projection on verified relay reads. */
export async function conversationHistory(
  event: EventData,
  conversation: Conversation,
  read: (filters: readonly ReadFilter[]) => Promise<readonly EventData[]>,
) {
  const { channelId, root } = conversation;
  const filter = {
    kinds: [9, 40002],
    "#h": [channelId],
    until: event.created_at,
  };
  const found = await read(
    root
      ? [
          { ...filter, ids: [root], limit: 1 },
          { ...filter, "#e": [root], limit: 50 },
        ]
      : [{ ...filter, limit: 50 }],
  );
  const ids = found.map((message) => message.id);
  const changes = ids.length
    ? await read([
        {
          kinds: [40003, 5, 9005],
          "#h": [channelId],
          "#e": ids,
          limit: 500,
          until: event.created_at,
        },
      ])
    : [];
  const messages = foldMessages(channelId, "", [...found, ...changes], {
    includeReplies: true,
  })
    .filter(
      (message) =>
        message.id !== event.id &&
        (!root || message.id === root || message.threadRootId === root),
    )
    .slice(-50)
    .map((message) => ({
      id: message.id,
      pubkey: message.authorId,
      created_at: message.createdAt,
      content: (message.sourceContent ?? message.content).slice(0, 4000),
    }));
  const section = root ? "thread-context" : "conversation-context";
  const text = JSON.stringify({
    note: "Recent context, not new requests. Previously supplied context may repeat. Up to 50 messages, 4000 characters each.",
    messages,
  })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `<${section}>\n${text}\n</${section}>\n`;
}
