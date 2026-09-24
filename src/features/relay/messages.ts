import { attachmentMessage, type UploadedAttachment } from "./attachments";
import { validReactionContent, type CustomEmoji } from "./emoji";
import type { EventData } from "./events";
import type { Outbox, OutboxRecovery } from "./outbox";

/** Domain convenience only. Delivery and read reconciliation remain session-owned. */
export function createMessages(
  outbox: Outbox | undefined,
  viewer: string | undefined,
  find: (id: string) => EventData | undefined,
  emojiTags: (content: string) => string[][],
  validateMentions: (channelId: string, pubkeys: readonly string[]) => void,
  canParticipate: (channelId: string) => boolean = () => true,
  relayOrigin?: string,
) {
  const writer = (kind: number, channelId: string) => {
    if (!canParticipate(channelId))
      throw new Error("Join the conversation before posting");
    if (!outbox?.supports(kind))
      throw new Error("This connection cannot publish that operation");
    return outbox;
  };
  const text = (content: string) => {
    const value = content.trim();
    if (!value) throw new Error("Message is empty");
    return value;
  };
  const mentionTags = (channelId: string, pubkeys: readonly string[]) => {
    if (
      pubkeys.length > 32 ||
      pubkeys.some((key) => !/^[0-9a-f]{64}$/.test(key))
    )
      throw new Error("Choose at most 32 valid mention recipients");
    const unique = [...new Set(pubkeys)];
    validateMentions(channelId, unique);
    return unique.map((key) => ["p", key]);
  };
  return Object.freeze({
    send(
      channelId: string,
      content: string,
      mentions: readonly string[] = [],
      attachments: readonly UploadedAttachment[] = [],
      recovery?: OutboxRecovery,
    ) {
      if (!channelId) throw new Error("A channel is required");
      const message = attachmentMessage(content, attachments, relayOrigin);
      return writer(9, channelId).send(
        {
          kind: 9,
          content: text(message.content),
          tags: [
            ["h", channelId],
            ...mentionTags(channelId, mentions),
            ...emojiTags(content),
            ...message.tags,
          ],
        },
        ...(recovery ? [recovery] : []),
      );
    },
    reply(
      channelId: string,
      rootId: string,
      content: string,
      mentions: readonly string[] = [],
      attachments: readonly UploadedAttachment[] = [],
    ) {
      if (!channelId) throw new Error("A channel is required");
      if (!/^[0-9a-f]{64}$/.test(rootId))
        throw new Error("A valid thread root is required");
      const message = attachmentMessage(content, attachments, relayOrigin);
      return writer(9, channelId).send({
        kind: 9,
        content: text(message.content),
        tags: [
          ["h", channelId],
          ["e", rootId, "", "reply"],
          ...mentionTags(channelId, mentions),
          ...emojiTags(content),
          ...message.tags,
        ],
      });
    },
    edit(messageId: string, content: string) {
      const original = find(messageId);
      if (!original || ![9, 40002].includes(original.kind))
        throw new Error("Load the message before editing it");
      if (original.pubkey !== viewer)
        throw new Error("Only your own messages can be edited");
      const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channelId) throw new Error("Message has no channel");
      return writer(40003, channelId).send({
        kind: 40003,
        content: text(content),
        tags: [["h", channelId], ["e", messageId], ...emojiTags(content)],
      });
    },
    react(messageId: string, content: string, emoji?: CustomEmoji) {
      const original = find(messageId);
      if (!original || ![9, 40002, 40008].includes(original.kind))
        throw new Error("Load the message before reacting to it");
      const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channelId) throw new Error("Message has no channel");
      const value = text(content);
      if (!validReactionContent(value)) throw new Error("Reaction is too long");
      return writer(7, channelId).send({
        kind: 7,
        content: value,
        tags: [
          ["h", channelId],
          ["e", messageId],
          ...(emoji && value.toLowerCase() === `:${emoji.shortcode}:`
            ? [["emoji", emoji.shortcode, emoji.url]]
            : emojiTags(value)),
        ],
      });
    },
    remove(eventIds: readonly string[]) {
      const ids = [...new Set(eventIds)];
      if (!ids.length || ids.length > 100)
        throw new Error("Choose between 1 and 100 events to remove");
      const originals = ids.map((id) => {
        const event = find(id);
        if (!event || ![7, 9, 40002].includes(event.kind))
          throw new Error("Load the message or reaction before removing it");
        if (event.pubkey !== viewer)
          throw new Error(
            "Only your own messages and reactions can be removed",
          );
        return event;
      });
      const channel = (event: EventData) =>
        event.tags.find(([name]) => name === "h")?.[1] ??
        (event.kind === 7
          ? find(
              event.tags.find(([name]) => name === "e")?.[1] ?? "",
            )?.tags.find(([name]) => name === "h")?.[1]
          : undefined);
      const first = originals[0];
      const channelId = first ? channel(first) : undefined;
      if (!channelId || originals.some((event) => channel(event) !== channelId))
        throw new Error("Removal must belong to one loaded conversation");
      return writer(5, channelId).send({
        kind: 5,
        content: "",
        tags: [
          ["h", channelId],
          ...ids.map((id) => ["e", id]),
          ...[...new Set(originals.map((event) => event.kind))].map((kind) => [
            "k",
            String(kind),
          ]),
        ],
      });
    },
    reactionTarget(event: Pick<EventData, "kind" | "tags">) {
      const target = event.tags.find(([name]) => name === "e")?.[1];
      if (event.kind === 7) return target;
      if (event.kind !== 5 || !target) return undefined;
      const original = find(target);
      return original?.kind === 7
        ? original.tags.find(([name]) => name === "e")?.[1]
        : undefined;
    },
    retry(id: string) {
      outbox?.retry(id);
    },
  });
}
