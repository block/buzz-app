import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { ReactionDelivery, ReactionTool } from "../conversation/ReactionTool";
import { InlineText } from "../conversation/InlineText";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
} from "../conversation/contracts";
import type { ChannelMessage, MessageReaction } from "../relay/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import type { OutgoingEvent } from "../relay/outbox";
import { recordReaction, useQuickReactions } from "./quick-reactions";

type Props = {
  row: ChannelMessage;
  session: RelaySession;
  scope: string;
  disabled: boolean;
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
};
const noSubscribe = () => () => {};
const noOperations = Object.freeze([]);
const empty = () => noOperations;

function useReactionAction({ row, session, scope, disabled }: Props) {
  const [error, setError] = useState<string>();
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = !disabled;
  });
  useLayoutEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const operations = useSyncExternalStore(
    session.outbox?.subscribe ?? noSubscribe,
    session.outbox?.snapshot ?? empty,
    session.outbox?.snapshot ?? empty,
  );
  const blocksToggle = (item: OutgoingEvent) =>
    ["sending", "failed", "unknown"].includes(item.delivery) &&
    session.messages.reactionTarget(item.event) === row.id;
  const busy = operations.some(blocksToggle);
  const toggle = (content: string, emoji?: CustomEmoji) => {
    if (!active.current || session.outbox?.snapshot().some(blocksToggle))
      return false;
    try {
      const group = row.reactions.find(
        (reaction) =>
          reaction.content === content && reaction.emoji?.url === emoji?.url,
      );
      const mine =
        group?.events.filter((event) => event.authorId === session.viewer) ??
        [];
      if (mine.length) session.messages.remove(mine.map((event) => event.id));
      else {
        session.messages.react(row.id, content, emoji);
        recordReaction(scope, content);
      }
      setError(undefined);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update reaction. Try again.",
      );
      return false;
    }
  };
  return { toggle, disabled: disabled || busy, error };
}

function ReactionLabel({
  reaction,
  row,
  inline,
  session,
}: {
  reaction: MessageReaction;
  row: ChannelMessage;
  inline: ContributionReader<InlineRenderer>;
  session: RelaySession;
}) {
  return (
    <InlineText
      registry={inline}
      content={{ text: reaction.content, message: row, reaction }}
      media={session.media}
    />
  );
}

/** PR 1's quick-control slot. The emoji contribution continues to own its picker. */
export function MessageReactionControls(props: Props) {
  const { row, session, scope, inline, tools } = props;
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const shortcuts = useQuickReactions(scope, catalog.entries);
  const action = useReactionAction(props);
  const select = (content: string) =>
    action.toggle(
      content,
      catalog.entries.find(
        (entry) => `:${entry.shortcode}:` === content.toLowerCase(),
      ),
    );
  return (
    <>
      {shortcuts.map((content) => {
        const emoji = catalog.entries.find(
          (entry) => `:${entry.shortcode}:` === content.toLowerCase(),
        );
        const mine = row.reactions.some(
          (reaction) =>
            reaction.content === content &&
            reaction.emoji?.url === emoji?.url &&
            reaction.events.some((event) => event.authorId === session.viewer),
        );
        return (
          <IconButton
            key={content}
            size="sm"
            variant="ghost"
            disabled={action.disabled}
            aria-label={`${mine ? "Remove" : "React with"} ${content}`}
            aria-pressed={mine}
            onClick={() => select(content)}
            icon={
              <ReactionLabel
                row={row}
                inline={inline}
                session={session}
                reaction={{ content, ...(emoji ? { emoji } : {}), events: [] }}
              />
            }
          />
        );
      })}
      <ReactionTool
        registry={tools}
        session={session}
        scope={scope}
        messageId={row.id}
        disabled={action.disabled}
        select={select}
        showDelivery={false}
      />
      {action.error && <span role="alert">{action.error}</span>}
    </>
  );
}

/** Always mounted under the message so failed add/remove operations stay recoverable. */
export function MessageReactions(
  props: Props & { onFocusedRemoval?: () => void },
) {
  const { row, session, inline } = props;
  const action = useReactionAction(props);
  return (
    <>
      {row.reactions.map((reaction) => {
        const authors = new Set(reaction.events.map((event) => event.authorId));
        const mine = authors.has(session.viewer ?? "");
        return (
          <Button
            key={JSON.stringify([reaction.content, reaction.emoji?.url])}
            size="sm"
            variant={mine ? "subtle" : "ghost"}
            disabled={action.disabled}
            aria-pressed={mine}
            aria-label={`${reaction.content}: ${authors.size} ${authors.size === 1 ? "person" : "people"}${mine ? ", including you" : ""}`}
            onClick={(event) => {
              const losesFocus =
                mine &&
                authors.size === 1 &&
                event.currentTarget === document.activeElement;
              if (action.toggle(reaction.content, reaction.emoji) && losesFocus)
                props.onFocusedRemoval?.();
            }}
          >
            <ReactionLabel
              reaction={reaction}
              row={row}
              inline={inline}
              session={session}
            />{" "}
            {authors.size}
          </Button>
        );
      })}
      {action.error && <span role="alert">{action.error}</span>}
      <ReactionDelivery session={session} messageId={row.id} />
    </>
  );
}
