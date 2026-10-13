import type { MessageReaction } from "../relay/contracts";

/** The runner does not mark automatic reactions. Product policy hides these two
 * glyphs from known agents, including deliberate uses, but never human reactions.
 * This is presentation only: signed events and reaction delivery remain intact. */
export function visibleReactions(
  reactions: readonly MessageReaction[],
  agents: ReadonlySet<string>,
): readonly MessageReaction[] {
  return reactions.flatMap((reaction) => {
    if (reaction.emoji || !["👀", "💬"].includes(reaction.content))
      return [reaction];
    const events = reaction.events.filter(
      (event) => !agents.has(event.authorId),
    );
    return events.length ? [{ ...reaction, events }] : [];
  });
}

/** Existing reaction evidence rendered as quiet work, not a new lifecycle.
 * Automatic and deliberate uses are indistinguishable on the wire. */
export function reactionWorkingAgents(
  reactions: readonly MessageReaction[],
  agents: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      reactions.flatMap((reaction) =>
        !reaction.emoji && ["👀", "💬"].includes(reaction.content)
          ? reaction.events
              .filter((event) => agents.has(event.authorId))
              .map((event) => event.authorId)
          : [],
      ),
    ),
  ].sort();
}
