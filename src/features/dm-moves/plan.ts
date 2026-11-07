import type { EventData } from "../relay/events";
import { foldMessages } from "../relay/fold";
import { eventMs } from "../relay/message-order";
import { threadReference } from "../relay/thread-reference";
import { MOVE_TAG, moveControl, type MoveRequest } from "./protocol";

export type MovedMessage = Readonly<{
  original: string;
  author: string;
  ms: number;
  content: string;
  parent?: string;
  tags: string[][];
}>;

/** Materialize the current edit/delete fold, then resolve parents through excluded ancestors. */
export function planMove(
  dm: string,
  relay: string,
  events: readonly EventData[],
  request: MoveRequest,
  owner?: (key: string) => string | undefined,
  through = Infinity,
  ancestry: Readonly<Record<string, string | undefined>> = {},
): MovedMessage[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const rows = foldMessages(dm, relay, events, {
    includeReplies: true,
    agentOwner: owner,
  });
  const messages = rows.filter((row) => {
    const event = byId.get(row.id);
    if (!event || moveControl(event) || row.membership || row.huddle)
      return false;
    const ms = eventMs(event);
    if (ms > through) return false;
    return (
      !request.from ||
      ms > request.from.ms ||
      (ms === request.from.ms && row.id >= request.from.id)
    );
  });
  if (messages.some((row) => row.attachments.length || row.diff))
    throw new Error(
      "Conversations containing attachments or patches cannot be converted yet.",
    );
  const included = new Set(messages.map((row) => row.id));
  const participants = new Set(request.authors.map((pair) => pair[0]));
  if (messages.some((row) => !participants.has(row.authorId)))
    throw new Error("The DM’s authors changed. Start a new conversion.");
  return messages
    .map((row) => {
      const event = byId.get(row.id);
      if (!event) throw new Error("The original message is unavailable.");
      const reference = threadReference(event);
      let parent = reference?.parentId;
      const visited = new Set([row.id]);
      while (parent && !included.has(parent)) {
        if (visited.has(parent))
          throw new Error("The DM contains a circular thread.");
        visited.add(parent);
        const ancestor = byId.get(parent);
        // The relay withholds deleted rows. Preserve observed IDs only, never
        // deleted content; do not guess where an unobserved parent belonged.
        if (!ancestor && !ancestry[parent] && parent !== reference?.rootId)
          throw new Error(
            "This conversation has a deleted reply whose original position is unavailable. Nothing has been copied. Try from a device that previously loaded the conversation.",
          );
        parent = ancestor
          ? threadReference(ancestor)?.parentId
          : ancestry[parent];
      }
      return {
        original: row.id,
        author: row.authorId,
        ms: eventMs(event),
        content: row.sourceContent ?? row.content,
        ...(parent ? { parent } : {}),
        // Do not notify the source recipients again; retain identity bindings as display metadata.
        tags: [
          ...[
            ...new Set([...row.mentions, ...(row.mentionReferences ?? [])]),
          ].map((key) => ["mention", key]),
          ...(row.emoji ?? []).map((e) => ["emoji", e.shortcode, e.url]),
        ],
      };
    })
    .sort((a, b) => a.ms - b.ms || a.original.localeCompare(b.original));
}

export function movedTemplate(
  request: MoveRequest,
  message: MovedMessage,
  root: string,
  parent: string,
) {
  return {
    kind: 9,
    content: message.content,
    tags: [
      ["h", request.target],
      ...(root === parent ? [] : [["e", root, "", "root"]]),
      ["e", parent, "", "reply"],
      [MOVE_TAG, request.move, message.original, String(message.ms)],
      ...message.tags,
    ],
  };
}
