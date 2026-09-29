import type { ChannelMessage } from "../relay/contracts";
import { replyTree } from "./reply-tree";

/** Explicit audience only. Never infer coordination from names or message prose. */
export function isAgentCoordination(
  row: ChannelMessage,
  known: ReadonlySet<string>,
  viewer?: string,
) {
  return (
    row.audience === "agents" &&
    row.authorId !== viewer &&
    !row.membership &&
    (row.agentEnvelope === true || known.has(row.authorId))
  );
}

/** Presentation only: skip hidden ancestors without changing signed rows or reply targets. */
export function conversationReplies(
  rows: readonly ChannelMessage[],
  hidden: ReadonlySet<string>,
  rootId?: string,
): readonly ChannelMessage[] {
  const tree = replyTree(rows, rootId);
  return rows
    .filter((row) => !hidden.has(row.id))
    .map((row) => {
      if (!row.replyParentId || !hidden.has(row.replyParentId)) return row;
      const parent = tree.ancestors(row.id).find((id) => !hidden.has(id));
      return { ...row, replyParentId: parent ?? rootId };
    });
}
