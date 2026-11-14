import { targetKey, type OpenTarget } from "../navigation/targets";

export function isSelectedDestination(
  destination: OpenTarget,
  target: OpenTarget,
) {
  const selectedKey = targetKey(target);
  if (targetKey(destination) === selectedKey) return true;
  if (
    destination.kind === "conversation" &&
    target.kind === "conversation" &&
    destination.messageId === undefined &&
    destination.panel === undefined
  ) {
    const conversationKey = (conversation: typeof destination) =>
      targetKey({
        version: 1,
        kind: "conversation",
        scope: conversation.scope,
        channelId: conversation.channelId,
      });
    return conversationKey(destination) === conversationKey(target);
  }
  if (
    destination.kind !== "page" ||
    target.kind !== "page" ||
    destination.scope !== undefined ||
    target.scope === undefined ||
    target.scope === null
  )
    return false;

  // An omitted page scope retains the current community.
  return targetKey({ ...destination, scope: target.scope }) === selectedKey;
}
