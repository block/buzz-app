import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ComposerTool, ContributionReader } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { messageViewKey } from "../messages/view-key";
import type { Outbox } from "../relay/outbox";

export function ReactionTool({
  registry,
  ...props
}: {
  registry: ContributionReader<ComposerTool>;
  session: RelaySession;
  scope: string;
  messageId: string;
  disabled: boolean;
}) {
  const tools = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const tool = [...tools]
    .sort((a, b) => a.key.localeCompare(b.key))
    .find((item) => item.reactionComponent);
  return tool ? (
    <ContributionBoundary
      key={contributionKey(tool)}
      fallback={<span role="status">Reactions unavailable</span>}
    >
      <OwnedReactionTool
        key={messageViewKey(props.session, props.scope, props.messageId)}
        registry={registry}
        tool={tool}
        {...props}
      />
    </ContributionBoundary>
  ) : null;
}

function OwnedReactionTool({
  registry,
  tool,
  session,
  scope,
  messageId,
  disabled,
}: {
  registry: ContributionReader<ComposerTool>;
  tool: Contribution<ComposerTool>;
  session: RelaySession;
  scope: string;
  messageId: string;
  disabled: boolean;
}) {
  const [error, setError] = useState<string>();
  const [sentId, setSentId] = useState<string>();
  const alive = useRef(false);
  const unavailable = useRef(disabled);
  useLayoutEffect(() => {
    unavailable.current = disabled;
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const Picker = tool.reactionComponent;
  return Picker ? (
    <>
      <Picker
        session={session}
        scope={scope}
        disabled={disabled}
        select={(emoji) => {
          if (
            !alive.current ||
            unavailable.current ||
            !registry.snapshot().includes(tool)
          )
            return false;
          try {
            setSentId(session.messages.react(messageId, emoji));
            setError(undefined);
            return true;
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not add reaction. Try again.",
            );
            return false;
          }
        }}
      />
      {error && <span role="alert">{error}</span>}
      {sentId && session.outbox && (
        <ReactionDelivery outbox={session.outbox} id={sentId} />
      )}
    </>
  ) : null;
}

function ReactionDelivery({ outbox, id }: { outbox: Outbox; id: string }) {
  const operations = useSyncExternalStore(
    outbox.subscribe,
    outbox.snapshot,
    outbox.snapshot,
  );
  const operation = operations.find((item) => item.event.id === id);
  if (!operation || !["failed", "unknown"].includes(operation.delivery))
    return null;
  return (
    <span role="status">
      {operation.delivery === "failed"
        ? "Couldn’t add reaction."
        : "Reaction delivery not confirmed."}{" "}
      <button type="button" onClick={() => outbox.retry(id)}>
        Retry reaction
      </button>
    </span>
  );
}
