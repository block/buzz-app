import type { ChannelMessage } from "../relay/contracts";

/** Thread UI intent, not transcript-to-reply attribution. Rows use the thread
 * owner's canonical order; equal timestamps alone never establish a later reply. */
export function pendingAgentRequest(
  rows: readonly ChannelMessage[],
  viewer: string | undefined,
  agents: ReadonlySet<string>,
  rootId: string | undefined,
) {
  if (!viewer || !rootId) return;
  let index = rows.length - 1;
  while (index >= 0) {
    const row = rows[index];
    if (row?.authorId === viewer && row.mentions.some((key) => agents.has(key)))
      break;
    index--;
  }
  const message = rows[index];
  if (!message) return;
  const pendingDelivery =
    message.delivery && !["accepted", "seen"].includes(message.delivery);
  const recipients = [...new Set(message.mentions)].filter(
    (key) =>
      agents.has(key) &&
      (pendingDelivery ||
        !rows
          .slice(index + 1)
          .some(
            (reply) =>
              reply.authorId === key &&
              reply.threadRootId === rootId &&
              reply.audience !== "agents",
          )),
  );
  return recipients.length ? { message, agents: recipients } : undefined;
}
