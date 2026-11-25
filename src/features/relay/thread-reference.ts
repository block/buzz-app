/** Message kinds that may appear as a thread root or reply. */
export const isThreadContent = (event: { kind: number }) =>
  [9, 40002, 40008].includes(event.kind);

/** NIP-10 matches relay ingest: last valid marked root/reply wins; a lone root is not a reply. */
export function threadReference(event: {
  readonly tags: readonly (readonly string[])[];
}) {
  let root: string | undefined;
  let reply: string | undefined;
  for (const [name, value, , marker] of event.tags) {
    if (name !== "e" || !value || !/^[0-9a-f]{64}$/i.test(value)) continue;
    if (marker === "root") root = value.toLowerCase();
    if (marker === "reply") reply = value.toLowerCase();
  }
  return reply ? { rootId: root ?? reply, parentId: reply } : undefined;
}

/**
 * Where a message's author asks the agents it mentions to answer. The
 * composer sets it from "Reply in thread" and "Reply in subthread"; see
 * "Reply placement" in docs/agents.md. Values:
 * - `top`: at the channel's top level. Only a top-level message can ask.
 * - `thread`: in the message's thread.
 * - `subthread`: under a thread reply, one level down. A reply already in a
 *   subthread stays in it; there is no deeper level.
 */
export const REPLY_PLACEMENT_TAG = "buzz:reply";
export type ReplyPlacement = "top" | "thread" | "subthread";

/** The placement a message asks for, or undefined when it asks for none
 * (or for one it can't have). */
export function replyPlacement(event: {
  readonly tags: readonly (readonly string[])[];
}): ReplyPlacement | undefined {
  const value = event.tags.find(([name]) => name === REPLY_PLACEMENT_TAG)?.[1];
  if (value === "top") return threadReference(event) ? undefined : "top";
  return value === "thread" || value === "subthread" ? value : undefined;
}

/** The message an agent answers under when `event` is in, or asks for, a
 * subthread. A reply already in a subthread keeps its parent, whatever it
 * asks, so an answer never goes deeper; a thread reply asking for a
 * subthread starts one under itself. */
export function subthreadReplyParent(event: {
  readonly id: string;
  readonly tags: readonly (readonly string[])[];
}) {
  const thread = threadReference(event);
  if (!thread) return undefined;
  if (thread.parentId !== thread.rootId) return thread.parentId;
  return replyPlacement(event) === "subthread" ? event.id : undefined;
}
