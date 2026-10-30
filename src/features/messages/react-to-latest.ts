import type { ChannelMessage } from "../relay/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "./composer-session";
import { recordReaction } from "./quick-reactions";

/** The newest message whose row would offer reaction controls. */
export function lastReactableMessage(
  session: ComposerSession,
  rows: readonly ChannelMessage[],
): ChannelMessage | undefined {
  if (!session.outbox?.supports(7) || !session.outbox.supports(5)) return;
  return [...rows]
    .reverse()
    .find(
      (row) =>
        !row.membership &&
        !row.huddle &&
        row.audience !== "agents" &&
        (!row.delivery ||
          row.delivery === "accepted" ||
          row.delivery === "seen"),
    );
}

/** A pending reaction or removal for this row blocks another toggle. */
export const blocksReactionToggle =
  (session: RelaySession, rowId: string) => (item: OutgoingEvent) =>
    ["sending", "failed", "unknown"].includes(item.delivery) &&
    session.messages.reactionTarget(item.event) === rowId;

/** One owner for toggle semantics: remove the viewer's reaction, else react. */
export function toggleReaction(
  session: RelaySession,
  scope: string,
  row: ChannelMessage,
  content: string,
  emoji?: CustomEmoji,
) {
  const group = row.reactions.find(
    (reaction) =>
      reaction.content === content && reaction.emoji?.url === emoji?.url,
  );
  const mine =
    group?.events.filter((event) => event.authorId === session.viewer) ?? [];
  if (mine.length) session.messages.remove(mine.map((event) => event.id));
  else {
    session.messages.react(row.id, content, emoji);
    recordReaction(scope, content);
  }
}
