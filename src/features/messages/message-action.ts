import type { ChannelMessage } from "../relay/contracts";

/** IRC-style narration is presentation of an ordinary, signed chat message. */
export function messageAction(content: string): string | undefined {
  if (!content.startsWith("/me ")) return;
  return content.slice(4).trim() || undefined;
}

/** Structured and delegated entries keep their own presentation and identity. */
export function narratedMessageAction(row: ChannelMessage): string | undefined {
  if (
    row.membership ||
    row.huddle ||
    row.diff ||
    row.forward ||
    row.workflowOwnerId ||
    row.audience === "agents" ||
    row.relayedFrom?.verified
  )
    return;
  return messageAction(row.content);
}

/** Remove only the displayed command; preserve attachment/identity boundaries. */
export function actionMessageContent(row: ChannelMessage): ChannelMessage {
  const remainder = row.content.slice(4);
  const start = row.content.length - remainder.trimStart().length;
  const content = remainder.trim();
  return {
    ...row,
    content,
    ...(row.attachmentSeams
      ? {
          attachmentSeams: row.attachmentSeams
            .filter((seam) => seam >= start && seam <= start + content.length)
            .map((seam) => seam - start),
        }
      : {}),
  };
}
